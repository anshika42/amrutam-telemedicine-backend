const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { AppError } = require('./errors');
const asyncHandler = require('./asyncHandler');
const db = require('../config/database');

const authenticateRequest = (allowMfaSetup) => asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'amrutam-api',
      audience: 'amrutam-client'
    });
  } catch {
    throw new AppError(401, 'Invalid or expired token', 'INVALID_TOKEN');
  }
  if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string') {
    throw new AppError(401, 'Invalid token payload', 'INVALID_TOKEN');
  }

  const isSetupToken = payload.purpose === 'mfa_setup';
  if (isSetupToken && (!allowMfaSetup || !payload.sub)) {
    throw new AppError(403, 'MFA setup token cannot access this resource', 'MFA_SETUP_ONLY');
  }
  if (!isSetupToken && payload.purpose) {
    throw new AppError(401, 'Invalid token purpose', 'INVALID_TOKEN');
  }
  const result = await db.query(
    'SELECT id, role, status, mfa_enabled FROM users WHERE id = $1',
    [payload.sub]
  );
  const user = result.rows[0];
  if (!user || user.status !== 'active') throw new AppError(401, 'Account unavailable', 'ACCOUNT_UNAVAILABLE');
  if (isSetupToken && (user.mfa_enabled || !['doctor', 'admin'].includes(user.role))) {
    throw new AppError(403, 'MFA setup token is no longer valid', 'MFA_SETUP_ONLY');
  }
  if (!allowMfaSetup && ['doctor', 'admin'].includes(user.role) && !user.mfa_enabled) {
    throw new AppError(403, 'MFA enrollment is required for this role', 'MFA_SETUP_REQUIRED');
  }
  req.user = { id: user.id, role: user.role };
  next();
});

const authenticate = authenticateRequest(false);
const authenticateMfaSetup = authenticateRequest(true);

module.exports = { authenticate, authenticateMfaSetup };
