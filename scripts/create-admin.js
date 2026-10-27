const bcrypt = require('bcryptjs');
const db = require('../src/config/database');
const env = require('../src/config/env');

async function createAdmin() {
  const name = process.env.ADMIN_NAME?.trim();
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!name || !email || !password || password.length < 12) {
    throw new Error('Set ADMIN_NAME, ADMIN_EMAIL, and an ADMIN_PASSWORD of at least 12 characters.');
  }

  const passwordHash = await bcrypt.hash(password, env.bcryptRounds);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id`,
      [name, email, passwordHash]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
       VALUES ($1, 'admin.created', 'user', $2)`,
      [result.rows[0].id, result.rows[0].id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackError => {
      console.error('Admin creation rollback failed:', rollbackError.message);
    });
    throw err;
  } finally {
    client.release();
  }
  console.log(`Admin account created: ${email}. Enable MFA at first login.`);
}

createAdmin()
  .catch(err => {
    if (err.code === '23505') {
      console.error('An account with that email already exists; no account was changed.');
    } else {
      console.error(err.message);
    }
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
