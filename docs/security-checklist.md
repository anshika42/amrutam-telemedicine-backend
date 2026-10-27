# Security checklist

- [x] Parameterized SQL queries
- [x] Password hashing (bcrypt)
- [x] JWT signature, issuer/audience and algorithm validation
- [x] Role-based middleware on privileged routes
- [x] Public registration cannot self-assign privileged role
- [x] TOTP MFA enrollment and login challenge; seeds encrypted with AES-256-GCM
- [x] Helmet, bounded JSON payloads, rate limiting
- [x] Authorization/password/OTP redaction; request URLs omit query strings from logs
- [x] Booking idempotency serialized per user/key and protected by transaction locks
- [x] Audit events for registration, doctor provisioning, bookings, consultation changes, and prescription activity
- [x] Request IDs, structured logs, and health checks
- [x] CI dependency audit (`npm audit --audit-level=high`)
- [ ] Production monitoring and alerts
- [ ] Email verification and secure account recovery
- [ ] Refresh token rotation/revocation
- [ ] TLS and managed encryption at rest/key rotation
- [ ] Audit review for remaining patient-record read and admin operations
- [ ] SAST and container image scanning in CI
- [ ] Payment provider signature verification and reconciliation
- [ ] Backup restore and disaster recovery drills
- [ ] Privacy/legal review and retention policy for health data

Do not store production secrets in Git. Use a secret manager, rotate secrets, and restrict access by environment.
