# Backup and disaster recovery strategy

1. Production: use managed PostgreSQL with multi-zone high availability and point-in-time recovery (PITR).
2. Backups: daily full backup plus continuous WAL/PITR where supported; encrypt backups with managed KMS keys.
3. Retention: define policy with product, security and legal stakeholders; restrict restore access.
4. Recovery targets: propose RPO <= 5 minutes and RTO <= 60 minutes for discussion; confirm business requirements before treating these as commitments.
5. Verification: automated backup health alerts; monthly isolated restore test; quarterly recovery exercise.
6. Regional disaster: maintain encrypted cross-region backup copies if required by compliance and budget.
7. Runbook: declare incident, freeze destructive changes, restore to isolated environment, validate row counts and application health, approve cutover, communicate status, and document lessons learned.
8. Evidence: record last successful backup, last restore test, achieved RPO/RTO and corrective actions.
9. Key recovery and rotation: back up secret-manager/KMS configuration independently from database backups. Restoring user rows without the matching MFA encryption key will prevent MFA verification. Before rotation, implement and test a controlled migration that can decrypt with the old key and re-encrypt with the replacement, validate MFA login for a test account, then retire the old key and record the rotation. The current application has no automated dual-key rotation command. Never put either key in the database backup or source control.
