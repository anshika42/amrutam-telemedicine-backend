require('dotenv').config();

const required = ['DATABASE_URL', 'JWT_SECRET', 'MFA_ENCRYPTION_KEY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long.');
}
if (!/^[a-fA-F0-9]{64}$/.test(process.env.MFA_ENCRYPTION_KEY)) {
  throw new Error('MFA_ENCRYPTION_KEY must be a 64-character hexadecimal key.');
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  mfaEncryptionKey: Buffer.from(process.env.MFA_ENCRYPTION_KEY, 'hex'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15m',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  logLevel: process.env.LOG_LEVEL || 'info'
};
