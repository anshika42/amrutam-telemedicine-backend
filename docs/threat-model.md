# Threat model

## Assets and data classification
- Credentials and access tokens: highly sensitive; never log.
- Patient profile, consultations and prescriptions: sensitive health data; least-privilege access and audit all reads/writes.
- Payment identifiers/status: sensitive financial metadata; never store card data.
- Public doctor profile/availability: lower sensitivity but protect integrity and abuse rate.

## Main threats and mitigations
| Threat | Mitigation in starter | Remaining production work |
|---|---|---|
| Password theft | bcrypt password hashing, minimum length, mandatory doctor/admin TOTP MFA, patient MFA opt-in | breached-password checks, secure recovery controls |
| Broken access control | JWT verification, current role lookup, role middleware, doctor ownership checks | review every endpoint and patient record access |
| SQL injection | parameterized PostgreSQL queries | keep query review and SAST in CI |
| Brute force / abuse | global limit plus 10-attempt auth-route limit per process/IP | shared per-IP and per-account gateway controls, bot protections |
| Booking race / replay | per-user/key transaction advisory lock, slot row lock, unique slot constraint, request-hash-checked replay | load test; define idempotency retention policy |
| Secret leakage | env vars and log redaction | managed secret store and rotation |
| Sensitive log exposure | redact authorization, password, and OTP values | central log access controls and retention policy |
| Dependency compromise | locked install and `npm audit` in CI | SAST/container scanning and patch SLA |
| Payment webhook spoofing | no webhook endpoint implemented | verify provider signature, timestamp, idempotency and reconciliation |
| Data loss / outage | documented backup requirement | managed backups, PITR, restore drills, multi-zone HA |

## OWASP-aligned controls
- **A01 Broken access control:** current database roles/status, doctor ownership checks, patient-only booking, admin-only analytics, and prescription ownership filtering.
- **A02 Cryptographic failures:** bcrypt password hashes, AES-256-GCM encrypted TOTP seeds, TLS required at production ingress/database, and encrypted managed backups.
- **A03 Injection:** Zod validation and parameterized SQL; never construct SQL from request strings.
- **A04 Insecure design:** patient-only public signup, transactional slot reservation, idempotency request-hash checks, and explicit consultation state transitions.
- **A05 Security misconfiguration:** Helmet, bounded JSON body size, explicit CORS origins, environment-provided secrets, and a non-root container.
- **A06 Vulnerable components:** lockfile-based installs and `npm audit --audit-level=high` in CI.
- **A07 Identification/authentication failures:** bcrypt, short-lived issuer/audience-checked JWTs, MFA required for doctors/admins, and a stricter auth-route rate limit.
- **A08 Software/data integrity failures:** DB uniqueness/foreign-key constraints, transactional audit events, and no unverified payment webhook endpoint.
- **A09 Security logging/monitoring failures:** redacted structured logs, request IDs, audit records for sensitive operations, and health checks. Production needs metrics and alerts.
- **A10 Server-side request forgery:** no route performs server-side fetches based on user-controlled URLs; validate and constrain URL inputs if integrations are added.

## Attack surface
Public: health endpoints, registration, login, doctor search. Authenticated: slots, bookings, consultation lifecycle, prescriptions, payment intent. Admin: doctor provisioning and aggregate analytics. Review request size, rate limits, authorization, error leakage and audit coverage for each route.

## Residual risks
TOTP MFA is implemented, but account recovery and MFA reset require a separately secured operational process. Encryption keys are supplied through environment configuration for local operation; production must use a managed secret/KMS service with a dual-key re-encryption rotation procedure. Audit coverage is focused on implemented sensitive workflows and must be reviewed as routes are added. Refresh-token lifecycle, payment gateway, async jobs, production alerting, multi-region infrastructure, and formal compliance review are not implemented.
