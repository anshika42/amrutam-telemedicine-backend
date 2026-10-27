const pino = require('pino');
const env = require('../config/env');
module.exports = pino({
  level: env.logLevel,
  redact: {
    paths: ['req.headers.authorization', 'password', 'token', 'req.body.password'],
    censor: '[REDACTED]'
  }
});
