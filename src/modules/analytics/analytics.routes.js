const router = require('express').Router();
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { authenticate } = require('../../common/auth.middleware');
const { allowRoles } = require('../../common/rbac.middleware');

router.get('/summary', authenticate, allowRoles('admin'), asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT
      (SELECT count(*)::int FROM users) AS total_users,
      (SELECT count(*)::int FROM doctors) AS total_doctors,
      (SELECT count(*)::int FROM consultations WHERE status = 'booked') AS booked_consultations,
      (SELECT count(*)::int FROM consultations WHERE status = 'completed') AS completed_consultations,
      (SELECT count(*)::int FROM payments WHERE status = 'paid') AS paid_payments
  `);
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type)
     VALUES ($1, 'analytics.summary_read', 'analytics')`,
    [req.user.id]
  );
  res.json({ data: result.rows[0] });
}));

module.exports = router;
