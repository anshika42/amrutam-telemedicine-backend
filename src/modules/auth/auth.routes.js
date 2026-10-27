const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const db = require('../../config/database');
const env = require('../../config/env');
const asyncHandler = require('../../common/asyncHandler');
const { AppError } = require('../../common/errors');
const { validate } = require('../../common/validate.middleware');
const { authenticate, authenticateMfaSetup } = require('../../common/auth.middleware');
const { createSecret, decryptSecret, encryptSecret, verifyCode } = require('../../common/totp');

const registerSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(255),
    password: z.string().min(12).max(128)
  }),
  params: z.object({}),
  query: z.object({})
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().email().max(255),
    password: z.string().min(1).max(128),
    otp: z.string().regex(/^\d{6}$/).optional()
  }),
  params: z.object({}),
  query: z.object({})
});
const otpSchema = z.object({
  body: z.object({ otp: z.string().regex(/^\d{6}$/) }),
  params: z.object({}),
  query: z.object({})
});
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'AUTH_RATE_LIMITED', message: 'Too many authentication attempts. Try again later.' } }
});

router.post('/register', authRateLimit, validate(registerSchema), asyncHandler(async (req, res) => {
  const { name, email, password } = req.validated.body;
  const passwordHash = await bcrypt.hash(password, env.bcryptRounds);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, lower($2), $3, 'patient')
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
       VALUES ($1, 'user.registered', 'user', $2)`,
      [result.rows[0].id, result.rows[0].id]
    );
    await client.query('COMMIT');
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'Registration transaction rollback failed');
    });
    if (err.code === '23505') throw new AppError(409, 'Email already registered', 'EMAIL_EXISTS');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/login', authRateLimit, validate(loginSchema), asyncHandler(async (req, res) => {
  const { email: rawEmail, password, otp } = req.validated.body;
  const email = rawEmail.toLowerCase();
  const result = await db.query(
    `SELECT id, name, email, role, status, password_hash, mfa_enabled, mfa_secret_enc
       FROM users WHERE email = $1`,
    [email]
  );
  const user = result.rows[0];
  const matches = user && await bcrypt.compare(password, user.password_hash);
  if (!matches || user.status !== 'active') throw new AppError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');
  if (user.mfa_enabled && (!otp || !verifyCode(decryptSecret(user.mfa_secret_enc), otp))) {
    throw new AppError(401, 'A valid MFA code is required', 'MFA_REQUIRED');
  }
  if (!user.mfa_enabled && ['doctor', 'admin'].includes(user.role)) {
    const setupToken = jwt.sign({ sub: user.id, role: user.role, purpose: 'mfa_setup' }, env.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '10m',
      issuer: 'amrutam-api',
      audience: 'amrutam-client'
    });
    return res.json({ data: { mfaSetupRequired: true, setupToken, tokenType: 'Bearer', expiresIn: '10m' } });
  }

  const accessToken = jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, {
    algorithm: 'HS256', expiresIn: env.jwtExpiresIn, issuer: 'amrutam-api', audience: 'amrutam-client'
  });
  res.json({ data: { accessToken, tokenType: 'Bearer', expiresIn: env.jwtExpiresIn,
    user: { id: user.id, name: user.name, email: user.email, role: user.role } } });
}));

router.post('/mfa/setup', authRateLimit, authenticateMfaSetup, asyncHandler(async (req, res) => {
  let secret;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT mfa_enabled, mfa_pending_secret_enc FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (!existing.rows[0]) throw new AppError(404, 'User not found', 'NOT_FOUND');
    if (existing.rows[0].mfa_enabled) throw new AppError(409, 'MFA is already enabled', 'MFA_ALREADY_ENABLED');
    if (existing.rows[0].mfa_pending_secret_enc) {
      secret = decryptSecret(existing.rows[0].mfa_pending_secret_enc);
    } else {
      secret = createSecret();
      await client.query(
        'UPDATE users SET mfa_pending_secret_enc = $1 WHERE id = $2',
        [encryptSecret(secret), req.user.id]
      );
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
         VALUES ($1, 'user.mfa_setup_started', 'user', $2)`,
        [req.user.id, req.user.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'MFA enrollment rollback failed');
    });
    throw err;
  } finally {
    client.release();
  }
  const label = encodeURIComponent(`Amrutam:${req.user.id}`);
  const issuer = encodeURIComponent('Amrutam');
  res.json({
    data: {
      secret,
      otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`
    }
  });
}));

router.post('/mfa/verify', authRateLimit, authenticateMfaSetup, validate(otpSchema), asyncHandler(async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT mfa_enabled, mfa_pending_secret_enc FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    const user = found.rows[0];
    if (!user || user.mfa_enabled || !user.mfa_pending_secret_enc) {
      throw new AppError(409, 'MFA setup has not been started', 'MFA_SETUP_REQUIRED');
    }
    if (!verifyCode(decryptSecret(user.mfa_pending_secret_enc), req.validated.body.otp)) {
      throw new AppError(400, 'Invalid MFA code', 'INVALID_MFA_CODE');
    }
    await client.query(
      `UPDATE users
          SET mfa_enabled = TRUE, mfa_secret_enc = mfa_pending_secret_enc,
              mfa_pending_secret_enc = NULL, updated_at = now()
        WHERE id = $1`,
      [req.user.id]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
       VALUES ($1, 'user.mfa_enabled', 'user', $2)`,
      [req.user.id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ data: { mfaEnabled: true } });
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      req.log?.error({ err: rollbackError }, 'MFA setup rollback failed');
    });
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
