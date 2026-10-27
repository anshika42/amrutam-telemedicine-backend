const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../../config/database');
const asyncHandler = require('../../common/asyncHandler');
const { AppError } = require('../../common/errors');
const { authenticate } = require('../../common/auth.middleware');
const { validate } = require('../../common/validate.middleware');

const bookingSchema = z.object({
  body: z.object({ slotId: z.string().uuid() }),
  params: z.object({}),
  query: z.object({})
});

router.post('/', authenticate, validate(bookingSchema), asyncHandler(async (req, res) => {
  if (req.user.role !== 'patient') throw new AppError(403, 'Only patients can book consultations', 'FORBIDDEN');
  const { slotId } = req.validated.body;
  const key = req.get('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 200) {
    throw new AppError(400, 'Idempotency-Key header (8–200 characters) is required', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ slotId })).digest('hex');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Serialize concurrent requests using the same user's key before checking for a replay.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${req.user.id}:${key}`]);
    const previous = await client.query(
      'SELECT request_hash, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE',
      [req.user.id, key]
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== requestHash) throw new AppError(409, 'Idempotency key reused with a different request', 'IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return res.status(201).json({ data: previous.rows[0].response_body, idempotentReplay: true });
    }

    // Row lock prevents two patients booking the same slot concurrently.
    const slotResult = await client.query(
      `SELECT id, doctor_id, starts_at, ends_at, status
         FROM availability_slots WHERE id = $1 FOR UPDATE`,
      [slotId]
    );
    const slot = slotResult.rows[0];
    if (!slot || slot.status !== 'open' || new Date(slot.starts_at) <= new Date()) {
      throw new AppError(409, 'Slot is unavailable', 'SLOT_UNAVAILABLE');
    }
    const created = await client.query(
      `INSERT INTO consultations (patient_id, doctor_id, slot_id, status)
       VALUES ($1, $2, $3, 'booked')
       RETURNING id, patient_id, doctor_id, slot_id, status, created_at`,
      [req.user.id, slot.doctor_id, slot.id]
    );
    await client.query("UPDATE availability_slots SET status = 'booked' WHERE id = $1", [slot.id]);
    const body = created.rows[0];
    await client.query(
      'INSERT INTO idempotency_keys (user_id, key, request_hash, response_body) VALUES ($1, $2, $3, $4)',
      [req.user.id, key, requestHash, JSON.stringify(body)]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
       VALUES ($1, 'consultation.booked', 'consultation', $2)`,
      [req.user.id, body.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ data: body, idempotentReplay: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'Booking transaction rollback failed');
    });
    if (err.code === '23505') return res.status(409).json({ error: { code: 'SLOT_UNAVAILABLE', message: 'Slot is already booked' } });
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/mine', authenticate, asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT c.id, c.status, c.created_at, c.doctor_id, c.slot_id,
            s.starts_at, s.ends_at
       FROM consultations c JOIN availability_slots s ON s.id = c.slot_id
      WHERE c.patient_id = $1 ORDER BY s.starts_at DESC LIMIT 100`,
    [req.user.id]
  );
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, metadata)
     VALUES ($1, 'consultation.listed', 'consultation_collection', $2::jsonb)`,
    [req.user.id, JSON.stringify({ count: result.rows.length })]
  );
  res.json({ data: result.rows });
}));

module.exports = router;
