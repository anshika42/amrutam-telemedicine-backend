# Simple Architecture

## Main parts

This project is a single Node.js application built with Express and PostgreSQL. It is split into route modules by feature, but runs as one service. Redis, queues, and separate microservices are not needed for this version.

```text
Client
  -> Express middleware (security headers, request checks, rate limit, logs)
  -> Feature routes (auth, doctors, availability, bookings, consultations)
  -> PostgreSQL
```

Routes validate input, check the logged-in user's role, run the database operation, and return JSON. Passwords are hashed. Doctor/admin access requires MFA. The API uses environment variables for database and signing keys.

## Booking flow

1. A patient sends a slot ID and an `Idempotency-Key`.
2. The API starts a database transaction and checks whether this key has been used by this patient.
3. A matching previous request returns its original result. Reusing the key with different input returns a conflict.
4. For a new key, PostgreSQL locks the slot so two patients cannot book it at the same time.
5. The API creates the consultation, marks the slot booked, records the idempotency response and writes an audit entry in the same transaction.
6. The transaction commits. If a database step fails, it rolls back.

The unique consultation slot constraint is an additional protection against double booking. Patients can safely retry a booking using the same key.

Patients and doctors can list their own consultations. Prescription access is limited to the patient, assigned doctor, or an admin. Private profile and consultation reads are added to the audit table.

## Database and performance

PostgreSQL stores users, profiles, doctor profiles, slots, consultations, prescriptions, payments, audit events, and idempotency keys. A small script creates the first admin; the admin can then provision doctor accounts. Foreign keys, unique constraints, and indexes protect the core relationships and common lookups. PostgreSQL connection pooling is configured in the API.

Search results and patient booking lists are limited so a request cannot return an unbounded number of rows. There is no cache or table partitioning; add those only if real traffic shows they are needed.

The target of 100,000 consultations per day and the latency targets have not been load-tested. This starter is not a deployment that guarantees those targets or 99.95% availability.

## Security and operations

- Helmet sets common security headers; CORS is limited to configured origins.
- Zod validates request inputs. SQL uses parameters rather than combining request text into SQL.
- JWT authentication checks the current user and role in the database.
- Passwords use bcrypt. Doctor/admin accounts must enable TOTP MFA before using protected routes; MFA seeds are encrypted using `MFA_ENCRYPTION_KEY`.
- Registration, MFA enrollment, bookings, consultations, and prescription activity create audit records.
- Pino writes request logs and hides authorization headers, passwords, and MFA codes.
- `/health/live` checks that the API process is running; `/health/ready` checks PostgreSQL.
- Docker Compose is for local development. Production needs HTTPS, managed secrets, database backups, and deployment-specific monitoring.

Payment intents are only pending database records. This project does not charge cards or connect to a payment provider.
