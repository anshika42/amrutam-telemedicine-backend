const app = require('./app');
const env = require('./config/env');
const logger = require('./common/logger');
const { pool } = require('./config/database');

const server = app.listen(env.port, () => logger.info({ port: env.port }, 'Amrutam API listening'));
async function shutdown(signal) {
  logger.info({ signal }, 'Graceful shutdown started');
  server.close(() => {
    pool.end()
      .then(() => process.exit(0))
      .catch(err => {
        logger.error({ err }, 'Database shutdown failed');
        process.exit(1);
      });
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
