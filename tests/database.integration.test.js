process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');
const env = require('../src/config/env');
const { generateCode } = require('../src/common/totp');

jest.setTimeout(20000);

const users = [];
let doctorId;
let slotId;
let patientToken;
let secondPatientToken;
let doctorToken;
let patientId;
let secondPatientId;
let doctorUserId;

function makeToken(id) {
  return jwt.sign({ sub: id }, env.jwtSecret, {
    algorithm: 'HS256',
    issuer: 'amrutam-api',
    audience: 'amrutam-client',
    expiresIn: '15m'
  });
}

async function createUser(role, name) {
  const email = `integration-${crypto.randomUUID()}@example.com`;
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash, role, mfa_enabled)
     VALUES ($1, $2, 'integration-test-hash', $3, $4)
     RETURNING id`,
    [name, email, role, role === 'doctor']
  );
  users.push(result.rows[0].id);
  return result.rows[0].id;
}

async function bookSlot(token, key) {
  return request(app)
    .post('/api/v1/bookings')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({ slotId });
}

beforeAll(async () => {
  await db.query('SELECT 1');
});

beforeEach(async () => {
  patientId = await createUser('patient', 'Integration Patient');
  secondPatientId = await createUser('patient', 'Second Integration Patient');
  doctorUserId = await createUser('doctor', 'Integration Doctor');
  const doctor = await db.query(
    "INSERT INTO doctors (user_id, specialty) VALUES ($1, 'General Medicine') RETURNING id",
    [doctorUserId]
  );
  doctorId = doctor.rows[0].id;
  const slot = await db.query(
    `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
     VALUES ($1, now() + interval '1 day', now() + interval '1 day 30 minutes')
     RETURNING id`,
    [doctorId]
  );
  slotId = slot.rows[0].id;
  patientToken = makeToken(patientId);
  secondPatientToken = makeToken(secondPatientId);
  doctorToken = makeToken(doctorUserId);
});

afterEach(async () => {
  if (!users.length) return;
  await db.query(
    `DELETE FROM audit_logs WHERE actor_id = ANY($1::uuid[])`,
    [users]
  );
  await db.query(
    `DELETE FROM prescriptions
      WHERE consultation_id IN (SELECT id FROM consultations WHERE patient_id = ANY($1::uuid[]))`,
    [users]
  );
  await db.query('DELETE FROM payments WHERE patient_id = ANY($1::uuid[])', [users]);
  await db.query('DELETE FROM idempotency_keys WHERE user_id = ANY($1::uuid[])', [users]);
  await db.query('DELETE FROM consultations WHERE patient_id = ANY($1::uuid[])', [users]);
  await db.query(
    'DELETE FROM availability_slots WHERE doctor_id IN (SELECT id FROM doctors WHERE user_id = ANY($1::uuid[]))',
    [users]
  );
  await db.query('DELETE FROM doctors WHERE user_id = ANY($1::uuid[])', [users]);
  await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
  users.length = 0;
});

afterAll(async () => {
  await db.pool.end();
});

describe('PostgreSQL-backed workflows', () => {
  test('public registration creates a patient and records the account event', async () => {
    const email = `registered-${crypto.randomUUID()}@example.com`;
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'New Patient', email, password: 'integration-password-123' });

    expect(response.statusCode).toBe(201);
    expect(response.body.data.role).toBe('patient');
    expect(response.body.data).not.toHaveProperty('password_hash');
    users.push(response.body.data.id);
    const audit = await db.query(
      "SELECT count(*)::int AS count FROM audit_logs WHERE actor_id = $1 AND action = 'user.registered'",
      [response.body.data.id]
    );
    expect(audit.rows[0].count).toBe(1);
  });

  test('admin login requires MFA and an authenticated admin can provision a doctor', async () => {
    const email = `admin-${crypto.randomUUID()}@example.com`;
    const password = 'integration-admin-password';
    const passwordHash = await bcrypt.hash(password, 4);
    const adminResult = await db.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Integration Admin', $1, $2, 'admin')
       RETURNING id`,
      [email, passwordHash]
    );
    const adminId = adminResult.rows[0].id;
    users.push(adminId);

    const login = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(login.statusCode).toBe(200);
    expect(login.body.data.mfaSetupRequired).toBe(true);

    const setup = await request(app)
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${login.body.data.setupToken}`);
    expect(setup.statusCode).toBe(200);
    const otp = generateCode(setup.body.data.secret);
    const verified = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .set('Authorization', `Bearer ${login.body.data.setupToken}`)
      .send({ otp });
    expect(verified.statusCode).toBe(200);

    const authenticated = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password, otp: generateCode(setup.body.data.secret) });
    expect(authenticated.statusCode).toBe(200);
    const provisioned = await request(app)
      .post('/api/v1/doctors')
      .set('Authorization', `Bearer ${authenticated.body.data.accessToken}`)
      .send({ userId: secondPatientId, specialty: 'Pediatrics' });

    expect(provisioned.statusCode).toBe(201);
    const audit = await db.query(
      "SELECT count(*)::int AS count FROM audit_logs WHERE actor_id = $1 AND action = 'doctor.provisioned'",
      [adminId]
    );
    expect(audit.rows[0].count).toBe(1);
  });

  test('health readiness checks the real database', async () => {
    const response = await request(app).get('/health/ready');
    expect(response.statusCode).toBe(200);
    expect(response.body.database).toBe('ok');
  });

  test('only one of two patients can book the same slot', async () => {
    const results = await Promise.all([
      bookSlot(patientToken, `integration-${crypto.randomUUID()}`),
      bookSlot(secondPatientToken, `integration-${crypto.randomUUID()}`)
    ]);

    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    const saved = await db.query('SELECT count(*)::int AS count FROM consultations WHERE slot_id = $1', [slotId]);
    expect(saved.rows[0].count).toBe(1);
  });

  test('retries with the same idempotency key return the original consultation', async () => {
    const key = `integration-${crypto.randomUUID()}`;
    const first = await bookSlot(patientToken, key);
    const retry = await bookSlot(patientToken, key);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.body.idempotentReplay).toBe(true);
    expect(retry.body.data.id).toBe(first.body.data.id);
  });

  test('cancelling a consultation makes its slot available again', async () => {
    const booking = await bookSlot(patientToken, `integration-${crypto.randomUUID()}`);
    const response = await request(app)
      .patch(`/api/v1/consultations/${booking.body.data.id}/status`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'cancelled' });
    const slot = await db.query('SELECT status FROM availability_slots WHERE id = $1', [slotId]);

    expect(response.statusCode).toBe(200);
    expect(slot.rows[0].status).toBe('open');
  });

  test('patient and doctor can list only their own consultations and complete a prescription flow', async () => {
    const booking = await bookSlot(patientToken, `integration-${crypto.randomUUID()}`);
    expect(booking.statusCode).toBe(201);

    const patientList = await request(app)
      .get('/api/v1/consultations/mine')
      .set('Authorization', `Bearer ${patientToken}`);
    const doctorList = await request(app)
      .get('/api/v1/consultations/mine')
      .set('Authorization', `Bearer ${doctorToken}`);
    const otherPatientList = await request(app)
      .get('/api/v1/consultations/mine')
      .set('Authorization', `Bearer ${secondPatientToken}`);

    expect(patientList.body.data).toHaveLength(1);
    expect(patientList.body.data[0].doctor_name).toBe('Integration Doctor');
    expect(doctorList.body.data).toHaveLength(1);
    expect(doctorList.body.data[0].patient_id).toBe(patientId);
    expect(otherPatientList.body.data).toHaveLength(0);

    const consultationId = booking.body.data.id;
    const progress = await request(app)
      .patch(`/api/v1/consultations/${consultationId}/status`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'in_progress' });
    expect(progress.statusCode).toBe(200);

    const completed = await request(app)
      .patch(`/api/v1/consultations/${consultationId}/status`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'completed' });
    expect(completed.statusCode).toBe(200);

    const prescription = await request(app)
      .post('/api/v1/prescriptions')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ consultationId, details: 'Integration test prescription' });
    expect(prescription.statusCode).toBe(201);

    const visiblePrescription = await request(app)
      .get(`/api/v1/prescriptions/consultation/${consultationId}`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(visiblePrescription.statusCode).toBe(200);
    expect(visiblePrescription.body.data[0].details).toBe('Integration test prescription');
  });

  test('users can read and update their own profile', async () => {
    const update = await request(app)
      .patch('/api/v1/users/me/profile')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ phone: '+911234567890', address: 'Test address' });
    expect(update.statusCode).toBe(200);
    expect(update.body.data.phone).toBe('+911234567890');

    const profile = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${patientToken}`);
    expect(profile.statusCode).toBe(200);
    expect(profile.body.data.email).toMatch(/^integration-/);
    expect(profile.body.data.address).toBe('Test address');
    expect(profile.body.data).not.toHaveProperty('password_hash');
    const audit = await db.query(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE actor_id = $1 AND action IN ('profile.read', 'profile.updated')`,
      [patientId]
    );
    expect(audit.rows[0].count).toBe(2);
  });

  test('a doctor can add their own availability and the change is audited', async () => {
    const startsAt = new Date(Date.now() + 2 * 86400000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60000);
    const response = await request(app)
      .post('/api/v1/availability')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ doctorId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });

    expect(response.statusCode).toBe(201);
    const audit = await db.query(
      "SELECT count(*)::int AS count FROM audit_logs WHERE actor_id = $1 AND action = 'availability.created'",
      [doctorUserId]
    );
    expect(audit.rows[0].count).toBe(1);
  });

  test('payment intent retries return the existing record and reject changed amounts', async () => {
    const booking = await bookSlot(patientToken, `integration-${crypto.randomUUID()}`);
    const token = `Bearer ${patientToken}`;
    const intent = { consultationId: booking.body.data.id, amountMinor: 12000, currency: 'INR' };
    const first = await request(app).post('/api/v1/payments/intents').set('Authorization', token).send(intent);
    const retry = await request(app).post('/api/v1/payments/intents').set('Authorization', token).send(intent);
    const conflict = await request(app)
      .post('/api/v1/payments/intents')
      .set('Authorization', token)
      .send({ ...intent, amountMinor: 13000 });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.error.code).toBe('PAYMENT_INTENT_CONFLICT');
  });
});
