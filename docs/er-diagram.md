# ER diagram

```mermaid
erDiagram
  USERS ||--o| PROFILES : has
  USERS ||--o| DOCTORS : may_have
  DOCTORS ||--o{ AVAILABILITY_SLOTS : publishes
  USERS ||--o{ CONSULTATIONS : patient
  DOCTORS ||--o{ CONSULTATIONS : conducts
  AVAILABILITY_SLOTS ||--o| CONSULTATIONS : reserved_by
  CONSULTATIONS ||--o| PRESCRIPTIONS : may_produce
  CONSULTATIONS ||--o| PAYMENTS : has
  USERS ||--o{ AUDIT_LOGS : performs
  USERS ||--o{ IDEMPOTENCY_KEYS : owns
```

`users.mfa_secret_enc` and `users.mfa_pending_secret_enc` contain AES-256-GCM encrypted TOTP seeds; `mfa_enabled` gates login for doctors and admins. Audit metadata must not contain credentials, OTPs, or prescription contents.
