const router = require('express').Router();
const { z } = require('zod');
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { AppError } = require('../../common/errors');
const { authenticate } = require('../../common/auth.middleware');
const { allowRoles } = require('../../common/rbac.middleware');
const { validate } = require('../../common/validate.middleware');

const statusSchema = z.object({
  body: z.object({ status: z.enum(['in_progress', 'completed', 'cancelled']) }),
  params: z.object({ id: z.string().uuid() }),
  query: z.object({})
});
const listSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: z.object({})
});

router.get('/mine', authenticate, allowRoles('patient', 'doctor'), validate(listSchema), asyncHandler(async (req, res) => {
  let result;
  if (req.user.role === 'patient') {
    result = await db.query(
      `SELECT c.id, c.status, c.created_at, s.starts_at, s.ends_at,
              d.id AS doctor_id, u.name AS doctor_name, d.specialty
         FROM consultations c
         JOIN availability_slots s ON s.id = c.slot_id
         JOIN doctors d ON d.id = c.doctor_id
         JOIN users u ON u.id = d.user_id
        WHERE c.patient_id = $1
        ORDER BY s.starts_at DESC
        LIMIT 100`,
      [req.user.id]
    );
  } else {
    result = await db.query(
      `SELECT c.id, c.status, c.created_at, s.starts_at, s.ends_at,
              u.id AS patient_id, u.name AS patient_name
         FROM consultations c
         JOIN availability_slots s ON s.id = c.slot_id
         JOIN users u ON u.id = c.patient_id
         JOIN doctors d ON d.id = c.doctor_id
        WHERE d.user_id = $1
        ORDER BY s.starts_at DESC
        LIMIT 100`,
      [req.user.id]
    );
  }
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, metadata)
     VALUES ($1, 'consultations.listed', 'consultation_collection', $2::jsonb)`,
    [req.user.id, JSON.stringify({ count: result.rows.length })]
  );
  res.json({ data: result.rows });
}));

router.patch('/:id/status', authenticate, allowRoles('doctor', 'admin'), validate(statusSchema), asyncHandler(async (req, res) => {
  const { status } = req.validated.body;
  const { id } = req.validated.params;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [id]);
    const consultation = found.rows[0];
    if (!consultation) throw new AppError(404, 'Consultation not found', 'NOT_FOUND');
    if (req.user.role === 'doctor') {
      const doctor = await client.query('SELECT id FROM doctors WHERE user_id = $1', [req.user.id]);
      if (!doctor.rows[0] || doctor.rows[0].id !== consultation.doctor_id) throw new AppError(403, 'Not your consultation', 'FORBIDDEN');
    }
    if (consultation.status === status) {
      await client.query('COMMIT');
      return res.json({ data: { id: consultation.id, status: consultation.status, updated_at: consultation.updated_at } });
    }
    const transitions = { booked: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'], completed: [], cancelled: [] };
    if (!transitions[consultation.status]?.includes(status)) throw new AppError(409, 'Invalid consultation status transition', 'INVALID_TRANSITION');
    const updated = await client.query(
      'UPDATE consultations SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, status, updated_at',
      [status, consultation.id]
    );
    if (status === 'cancelled') await client.query("UPDATE availability_slots SET status = 'open' WHERE id = $1", [consultation.slot_id]);
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'consultation.status_changed', 'consultation', $2, $3::jsonb)`,
      [req.user.id, consultation.id, JSON.stringify({ from: consultation.status, to: status })]
    );
    await client.query('COMMIT');
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'Consultation transaction rollback failed');
    });
    throw err;
  } finally { client.release(); }
}));

module.exports = router;
