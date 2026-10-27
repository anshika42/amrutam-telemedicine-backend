const router = require('express').Router();
const { z } = require('zod');
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { AppError } = require('../../common/errors');
const { authenticate } = require('../../common/auth.middleware');
const { allowRoles } = require('../../common/rbac.middleware');
const { validate } = require('../../common/validate.middleware');

const createSlotSchema = z.object({
  body: z.object({
    doctorId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true })
  }),
  params: z.object({}),
  query: z.object({})
});
const listSlotsSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: z.object({ doctorId: z.string().uuid() })
});

router.get('/', validate(listSlotsSchema), asyncHandler(async (req, res) => {
  const { doctorId } = req.validated.query;
  const result = await db.query(
    `SELECT id, doctor_id, starts_at, ends_at
       FROM availability_slots
      WHERE doctor_id = $1 AND status = 'open' AND starts_at > now()
      ORDER BY starts_at LIMIT 100`,
    [doctorId]
  );
  res.json({ data: result.rows });
}));

router.post('/', authenticate, allowRoles('doctor', 'admin'), validate(createSlotSchema), asyncHandler(async (req, res) => {
  const { doctorId, startsAt, endsAt } = req.validated.body;
  if (req.user.role === 'doctor') {
    const own = await db.query('SELECT id FROM doctors WHERE user_id = $1', [req.user.id]);
    if (!own.rows[0] || own.rows[0].id !== doctorId) throw new AppError(403, 'Cannot create another doctor’s slots', 'FORBIDDEN');
  }
  const start = new Date(startsAt), end = new Date(endsAt);
  if (start <= new Date() || end <= start) {
    throw new AppError(400, 'Valid future startsAt and endsAt are required', 'VALIDATION_ERROR');
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
       VALUES ($1, $2, $3) RETURNING id, doctor_id, starts_at, ends_at, status`,
      [doctorId, start.toISOString(), end.toISOString()]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
       VALUES ($1, 'availability.created', 'availability_slot', $2)`,
      [req.user.id, result.rows[0].id]
    );
    await client.query('COMMIT');
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'Availability transaction rollback failed');
    });
    if (err.code === '23505') throw new AppError(409, 'Availability slot already exists', 'SLOT_EXISTS');
    if (err.code === '23503') throw new AppError(404, 'Doctor profile not found', 'DOCTOR_NOT_FOUND');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
