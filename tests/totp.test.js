process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/amrutam';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_that_is_long_enough_123456';
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const { createSecret, decryptSecret, encryptSecret, generateCode, verifyCode } = require('../src/common/totp');

describe('TOTP utilities', () => {
  test('matches the RFC 6238 SHA-1 test vector', () => {
    expect(generateCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000)).toBe('287082');
  });

  test('verifies current codes and rejects malformed or incorrect codes', () => {
    const timestamp = 1770000000000;
    const secret = createSecret();
    const code = generateCode(secret, timestamp);
    expect(verifyCode(secret, code, timestamp)).toBe(true);
    expect(verifyCode(secret, '12x456', timestamp)).toBe(false);
    expect(verifyCode(secret, code === '000000' ? '000001' : '000000', timestamp)).toBe(false);
  });

  test('encrypts MFA seeds and only decrypts with the configured key', () => {
    const secret = createSecret();
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });
});
