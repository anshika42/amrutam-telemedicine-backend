process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/amrutam';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_that_is_long_enough_123456';
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.LOG_LEVEL = 'silent';

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getClient: jest.fn()
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const app = require('../src/app');
const env = require('../src/config/env');

const patientId = '11111111-1111-4111-8111-111111111111';
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const slotId = '22222222-2222-4222-8222-222222222222';
const alternateSlotId = '33333333-3333-4333-8333-333333333333';
const doctorId = '44444444-4444-4444-8444-444444444444';

describe('booking idempotency', () => {
  let idempotencyRecord;
  let slotStatus;
  let clientQuery;
  let slotLookups;
  const token = jwt.sign({ sub: patientId }, env.jwtSecret, {
    algorithm: 'HS256',
    issuer: 'amrutam-api',
    audience: 'amrutam-client',
    expiresIn: '1h'
  });

  beforeEach(() => {
    idempotencyRecord = null;
    slotStatus = 'open';
    slotLookups = 0;
    db.query.mockResolvedValue({ rows: [{ id: patientId, role: 'patient', status: 'active' }] });
    clientQuery = jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT request_hash, response_body FROM idempotency_keys')) {
        return { rows: idempotencyRecord ? [idempotencyRecord] : [] };
      }
      if (sql.includes('FROM availability_slots WHERE id = $1 FOR UPDATE')) {
        slotLookups += 1;
        return { rows: [{ id: params[0], doctor_id: doctorId, starts_at: new Date(Date.now() + 60000), status: slotStatus }] };
      }
      if (sql.includes('INSERT INTO consultations')) {
        return { rows: [{
          id: '55555555-5555-4555-8555-555555555555',
          patient_id: patientId,
          doctor_id: doctorId,
          slot_id: slotId,
          status: 'booked'
        }] };
      }
      if (sql.includes("UPDATE availability_slots SET status = 'booked'")) {
        slotStatus = 'booked';
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO idempotency_keys')) {
        idempotencyRecord = {
          request_hash: params[2],
          response_body: JSON.parse(params[3])
        };
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO audit_logs')) return { rows: [] };
      throw new Error(`Unexpected query in booking test: ${sql}`);
    });
    db.getClient.mockResolvedValue({ query: clientQuery, release: jest.fn() });
  });

  test('replays the original result for a retry with the same key and payload', async () => {
    const first = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'booking-retry-001')
      .send({ slotId });
    const replay = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'booking-retry-001')
      .send({ slotId });

    expect(first.statusCode).toBe(201);
    expect(first.body.data.id).toBe(replay.body.data.id);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(slotLookups).toBe(1);
  });

  test('rejects reuse of an idempotency key with a different payload', async () => {
    await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'booking-retry-002')
      .send({ slotId });
    const conflict = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'booking-retry-002')
      .send({ slotId: alternateSlotId });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(slotLookups).toBe(1);
  });

  test('requires MFA enrollment before an admin can access protected routes', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: adminId, role: 'admin', status: 'active', mfa_enabled: false }]
    });
    const adminToken = jwt.sign({ sub: adminId }, env.jwtSecret, {
      algorithm: 'HS256',
      issuer: 'amrutam-api',
      audience: 'amrutam-client',
      expiresIn: '1h'
    });
    const response = await request(app)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('MFA_SETUP_REQUIRED');
  });
});
