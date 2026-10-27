const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const env = require('./config/env');
const logger = require('./common/logger');
const rateLimit = require('./common/rateLimit');
const { AppError } = require('./common/errors');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.corsOrigin.split(',').map(s => s.trim()), credentials: false }));
app.use(express.json({ limit: '100kb' }));
app.use(pinoHttp({
  logger,
  genReqId: () => crypto.randomUUID(),
  redact: ['req.headers.authorization', 'req.body.password', 'req.body.otp'],
  serializers: {
    req: req => ({
      id: req.id,
      method: req.method,
      url: req.url ? req.url.split('?')[0] : '',
      remoteAddress: req.socket?.remoteAddress
    })
  }
}));
app.use((req, res, next) => {
  res.setHeader('X-Request-ID', req.id);
  next();
});
app.use(rateLimit);

app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (req, res, next) => {
  try {
    const db = require('./config/database');
    await db.query('SELECT 1');
    res.json({ status: 'ready', database: 'ok' });
  } catch (err) { next(err); }
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(require('../openapi.json')));
app.use('/api/v1', require('./routes'));

app.use((req, res, next) => next(new AppError(404, 'Route not found', 'NOT_FOUND')));
app.use((err, req, res, next) => {
  const status = err.statusCode || (err.type === 'entity.parse.failed' ? 400 : 500);
  const code = err.code || (err.type === 'entity.parse.failed' ? 'INVALID_JSON' : 'INTERNAL_SERVER_ERROR');
  if (status >= 500) logger.error({ err }, 'Request failed');
  res.status(status).json({
    error: {
      code,
      message: status >= 500 ? 'Internal server error' : err.message || 'Invalid request body'
    }
  });
});

module.exports = app;
