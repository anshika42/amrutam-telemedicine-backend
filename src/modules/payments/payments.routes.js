const router = require('express').Router();
const { z } = require('zod');
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { AppError } = require('../../common/errors');
const { authenticate } = require('../../common/auth.middleware');
const { validate } = require('../../common/validate.middleware');

const paymentIntentSchema = z.object({
  body: z.object({
    consultationId: z.string().uuid(),
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/).optional().default('INR')
  }),
  params: z.object({}),
  query: z.object({})
});

// This assignment starter records payment intents only. Integrate a real provider and verify
// signed webhooks before ever marking an intent as paid. Never accept card details here.
router.post('/intents', authenticate, validate(paymentIntentSchema), asyncHandler(async (req, res) => {
  if (req.user.role !== 'patient') throw new AppError(403, 'Only patients can create payment intents', 'FORBIDDEN');
  const { consultationId, amountMinor, currency } = req.validated.body;
  const consultation = await db.query('SELECT id FROM consultations WHERE id = $1 AND patient_id = $2', [consultationId, req.user.id]);
  if (!consultation.rows[0]) throw new AppError(404, 'Consultation not found', 'NOT_FOUND');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO payments (consultation_id, patient_id, amount_minor, currency, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (consultation_id) DO NOTHING
       RETURNING id, consultation_id, amount_minor, currency, status, created_at`,
      [consultationId, req.user.id, amountMinor, currency]
    );
    let payment = created.rows[0];
    if (!payment) {
      const existing = await client.query(
        `SELECT id, consultation_id, patient_id, amount_minor, currency, status, created_at
           FROM payments WHERE consultation_id = $1 FOR UPDATE`,
        [consultationId]
      );
      payment = existing.rows[0];
      if (!payment || payment.patient_id !== req.user.id ||
          Number(payment.amount_minor) !== amountMinor || payment.currency.trim() !== currency) {
        throw new AppError(409, 'Payment intent already exists with different details', 'PAYMENT_INTENT_CONFLICT');
      }
    } else {
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
         VALUES ($1, 'payment_intent.created', 'payment', $2)`,
        [req.user.id, payment.id]
      );
    }
    await client.query('COMMIT');
    res.status(created.rows[0] ? 201 : 200).json({
      data: payment,
      idempotentReplay: !created.rows[0],
      note: 'Payment provider integration is not configured; this is not a completed charge.'
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'Payment transaction rollback failed');
    });
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
