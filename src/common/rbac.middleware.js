const { AppError } = require('./errors');

const allowRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new AppError(403, 'Insufficient permissions', 'FORBIDDEN'));
  }
  next();
};

module.exports = { allowRoles };
