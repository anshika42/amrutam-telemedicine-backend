const router = require('express').Router();
const { z } = require('zod');
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { validate } = require('../../common/validate.middleware');

const searchSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: z.object({ q: z.string().trim().max(100).optional().default('') })
});

router.get('/doctors', validate(searchSchema), asyncHandler(async (req, res) => {
  const term = req.validated.query.q;
  const result = await db.query(
    `SELECT d.id, u.name, d.specialty, d.bio
       FROM doctors d JOIN users u ON u.id = d.user_id
      WHERE u.status = 'active'
        AND ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR d.specialty ILIKE '%' || $1 || '%')
      ORDER BY d.specialty, u.name LIMIT 50`,
    [term]
  );
  res.json({ data: result.rows });
}));

module.exports = router;
