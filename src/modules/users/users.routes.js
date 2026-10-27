const router = require('express').Router();
const { z } = require('zod');
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { authenticate } = require('../../common/auth.middleware');
const { validate } = require('../../common/validate.middleware');

const profileSchema = z.object({
  body: z.object({
    phone: z.string().trim().max(30).optional(),
    dateOfBirth: z.string().date().optional(),
    address: z.string().trim().max(1000).optional()
  }).refine(profile => Object.keys(profile).length > 0, 'At least one profile field is required'),
  params: z.object({}),
  query: z.object({})
});

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.created_at,
            p.phone, p.date_of_birth, p.address
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = $1`,
    [req.user.id]
  );
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
     VALUES ($1, 'profile.read', 'profile', $2)`,
    [req.user.id, req.user.id]
  );
  res.json({ data: result.rows[0] });
}));

router.patch('/me/profile', authenticate, validate(profileSchema), asyncHandler(async (req, res) => {
  const { phone, dateOfBirth, address } = req.validated.body;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO profiles (user_id, phone, date_of_birth, address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET phone = COALESCE(EXCLUDED.phone, profiles.phone),
             date_of_birth = COALESCE(EXCLUDED.date_of_birth, profiles.date_of_birth),
             address = COALESCE(EXCLUDED.address, profiles.address)
       RETURNING user_id, phone, date_of_birth, address`,
      [req.user.id, phone ?? null, dateOfBirth ?? null, address ?? null]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
       VALUES ($1, 'profile.updated', 'profile', $2)`,
      [req.user.id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'Profile update rollback failed');
    });
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
