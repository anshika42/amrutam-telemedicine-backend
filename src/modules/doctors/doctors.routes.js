const router = require('express').Router();
const { z } = require('zod');
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { AppError } = require('../../common/errors');
const { authenticate } = require('../../common/auth.middleware');
const { allowRoles } = require('../../common/rbac.middleware');
const { validate } = require('../../common/validate.middleware');

const createDoctorSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
    specialty: z.string().trim().min(1).max(120),
    bio: z.string().max(2000).optional()
  }),
  params: z.object({}),
  query: z.object({})
});
const doctorSearchSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: z.object({
    q: z.string().trim().max(100).optional().default(''),
    specialty: z.string().trim().max(100).optional().default(''),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).max(1000000).optional().default(0)
  })
});

router.get('/', validate(doctorSearchSchema), asyncHandler(async (req, res) => {
  const { q, specialty, limit, offset } = req.validated.query;
  const result = await db.query(
    `SELECT d.id, u.name, d.specialty, d.bio
       FROM doctors d JOIN users u ON u.id = d.user_id
      WHERE u.status = 'active'
        AND ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR d.specialty ILIKE '%' || $1 || '%')
        AND ($2 = '' OR d.specialty ILIKE '%' || $2 || '%')
      ORDER BY u.name LIMIT $3 OFFSET $4`,
    [q, specialty, limit, offset]
  );
  res.json({ data: result.rows, pagination: { limit, offset } });
}));

router.post('/', authenticate, allowRoles('admin'), validate(createDoctorSchema), asyncHandler(async (req, res) => {
  const { userId, specialty, bio = '' } = req.validated.body;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const user = await client.query(
      "UPDATE users SET role = 'doctor', updated_at = now() WHERE id = $1 AND status = 'active' AND role IN ('patient', 'doctor') RETURNING id",
      [userId]
    );
    if (!user.rows[0]) throw new AppError(404, 'Active user not found', 'USER_NOT_FOUND');
    const result = await client.query(
      `INSERT INTO doctors (user_id, specialty, bio)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, specialty, bio`,
      [userId, specialty, bio]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
       VALUES ($1, 'doctor.provisioned', 'doctor', $2)`,
      [req.user.id, result.rows[0].id]
    );
    await client.query('COMMIT');
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'Doctor provisioning rollback failed');
    });
    if (err.code === '23505') throw new AppError(409, 'Doctor profile already exists', 'DOCTOR_EXISTS');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
