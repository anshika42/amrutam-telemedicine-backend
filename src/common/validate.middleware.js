const { AppError } = require('./errors');
const validate = (schema) => (req, res, next) => {
  const parsed = schema.safeParse({ body: req.body, params: req.params, query: req.query });
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), 'VALIDATION_ERROR'));
  }
  req.validated = parsed.data;
  next();
};
module.exports = { validate };
