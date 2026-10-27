const router = require('express').Router();
const { z } = require('zod');
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { AppError } = require('../../common/errors');
const { authenticate } = require('../../common/auth.middleware');
const { allowRoles } = require('../../common/rbac.middleware');
const { validate } = require('../../common/validate.middleware');

const createPrescriptionSchema = z.object({
  body: z.object({
    consultationId: z.string().uuid(),
    details: z.string().trim().min(1).max(10000)
  }),
  params: z.object({}),
  query: z.object({})
});
const consultationParamsSchema = z.object({
  body: z.object({}),
  params: z.object({ consultationId: z.string().uuid() }),
  query: z.object({})
});

router.post('/', authenticate, allowRoles('doctor'), validate(createPrescriptionSchema), asyncHandler(async (req, res) => {
  const { consultationId, details } = req.validated.body;
  const doctor = await db.query('SELECT id FROM doctors WHERE user_id = $1', [req.user.id]);
  if (!doctor.rows[0]) throw new AppError(403, 'Doctor profile required', 'FORBIDDEN');
  const consultation = await db.query(
    "SELECT id FROM consultations WHERE id = $1 AND doctor_id = $2 AND status = 'completed'",
    [consultationId, doctor.rows[0].id]
  );
  if (!consultation.rows[0]) throw new AppError(404, 'Completed consultation not found for this doctor', 'NOT_FOUND');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO prescriptions (consultation_id, doctor_id, details)
       VALUES ($1, $2, $3)
       ON CONFLICT (consultation_id) DO NOTHING
       RETURNING id, consultation_id, doctor_id, details, created_at`,
      [consultationId, doctor.rows[0].id, details]
    );
    let prescription = result.rows[0];
    if (!prescription) {
      const existing = await client.query(
        'SELECT id, consultation_id, doctor_id, details, created_at FROM prescriptions WHERE consultation_id = $1',
        [consultationId]
      );
      prescription = existing.rows[0];
      if (!prescription || prescription.doctor_id !== doctor.rows[0].id || prescription.details !== details) {
        throw new AppError(409, 'A different prescription already exists', 'PRESCRIPTION_CONFLICT');
      }
    } else {
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
         VALUES ($1, 'prescription.created', 'prescription', $2)`,
        [req.user.id, prescription.id]
      );
    }
    await client.query('COMMIT');
    res.status(result.rows[0] ? 201 : 200).json({ data: prescription });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'Prescription transaction rollback failed');
    });
    if (err.code === '23505') throw new AppError(409, 'Prescription already exists', 'PRESCRIPTION_EXISTS');
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/consultation/:consultationId', authenticate, validate(consultationParamsSchema), asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT p.id, p.consultation_id, p.details, p.created_at
       FROM prescriptions p JOIN consultations c ON c.id = p.consultation_id
      WHERE c.id = $1 AND (c.patient_id = $2 OR p.doctor_id = (SELECT id FROM doctors WHERE user_id = $2) OR $3 = 'admin')`,
    [req.validated.params.consultationId, req.user.id, req.user.role]
  );
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
     VALUES ($1, 'prescription.read', 'consultation', $2)`,
    [req.user.id, req.validated.params.consultationId]
  );
  res.json({ data: result.rows });
}));

module.exports = router;
