# Amrutam Telemedicine Backend

Node.js + Express + PostgreSQL modular-monolith backend for telemedicine workflows.

## Prerequisites
- Node.js 20+
- npm
- Docker Desktop (recommended for PostgreSQL)
- Git

## Quick start (Docker)
1. Copy `.env.example` to `.env` and set `JWT_SECRET` to a random value of at least 32 characters. Set `MFA_ENCRYPTION_KEY` to exactly 64 hexadecimal characters (32 random bytes); the example value is development-only.
2. Start services from the project root:
   ```bash
   docker compose -f infra/docker-compose.yml up --build
   ```
3. Verify:
   - `GET http://localhost:3000/health/live`
   - `GET http://localhost:3000/health/ready`
   - Swagger UI: `http://localhost:3000/docs`

The Compose API service uses a local-only development secret. Never use it in production.

## Local Node process
1. Start PostgreSQL and create database `amrutam`.
2. Apply schema: `psql "postgres://postgres:postgres@localhost:5432/amrutam" -f database/schema.sql`
3. `cp .env.example .env` and edit `DATABASE_URL`, `JWT_SECRET`, and `MFA_ENCRYPTION_KEY`.
4. Run:
   ```bash
   npm install
   npm run dev
   ```
On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

## Create the first admin

An admin account is needed to add doctor profiles. With PostgreSQL running and `.env` configured, run this in PowerShell:

```powershell
$env:ADMIN_NAME = "Amrutam Admin"
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "replace-this-with-a-long-password"
npm run create:admin
Remove-Item Env:ADMIN_NAME, Env:ADMIN_EMAIL, Env:ADMIN_PASSWORD
```

Log in using those credentials and complete the MFA setup before using admin routes. The script creates a new account only; it does not change an existing account.

## API examples
Register patient:
```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo Patient","email":"patient@example.com","password":"use-a-long-demo-password"}'
```
Login:
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"patient@example.com","password":"use-a-long-demo-password"}'
```
Use returned accessToken as `Authorization: Bearer TOKEN`.

Doctor search:
```bash
curl "http://localhost:3000/api/v1/doctors?q=cardio&limit=20&offset=0"
```
Book a slot (replace SLOT_UUID and TOKEN):
```bash
curl -X POST http://localhost:3000/api/v1/bookings \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-booking-0001" \
  -d '{"slotId":"SLOT_UUID"}'
```

After login, doctors/admins without MFA receive a short-lived `setupToken` (not a general API access token); use it as the Bearer token for `POST /api/v1/auth/mfa/setup`, scan the returned provisioning URI, and verify a current six-digit code with `POST /api/v1/auth/mfa/verify`. After verification, log in again with the OTP to receive a normal access token. Patients can enroll using their access token; once enabled, their logins also require the code in `otp`.

## Tests
```bash
npm install
npm test
npm run test:integration
npm run test:coverage
```
`npm test` runs without a database. `npm run test:integration` needs PostgreSQL with `database/schema.sql` applied; it tests real booking concurrency, user profiles, and consultation/prescription workflows. CI runs both suites against PostgreSQL.

## Git
```bash
git init
git add .
git commit -m "Initial telemedicine backend"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

## Implemented capabilities and limits
- REST API for patient registration/login, admin doctor provisioning, doctor search and availability, patient booking, consultation lifecycle, prescriptions, payment-intent records, and admin summary analytics.
- User profile endpoints and a one-time admin creation script.
- TOTP MFA enrollment and login challenge; AES-256-GCM encrypted TOTP seed storage.
- Safe booking retries: repeated requests with the same key do not create duplicate bookings; database locks prevent two patients booking the same slot.
- RBAC and ownership checks, Zod request validation, request-size/rate limits, Helmet, JWT issuer/audience/algorithm checks, and redacted structured request logs.
- PostgreSQL schema, local Docker Compose, non-root Docker image with health check, CI tests/dependency audit, basic request logs, and architecture/security/ER/sequence/DR documentation.

The payment endpoint creates a pending database record only; it does not charge a payment method. This project uses simple request logs and health checks instead of distributed tracing or a metrics stack. Availability (99.95%) and p95 latency (<200ms reads, <500ms writes) are targets, not measured guarantees.
