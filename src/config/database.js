const { Pool } = require('pg');
const env = require('./env');
const logger = require('../common/logger');

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,
  ssl: env.nodeEnv === 'production' ? { rejectUnauthorized: true } : false
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle PostgreSQL client error');
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool
};
