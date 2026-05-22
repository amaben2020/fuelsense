const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const signToken = (customer) =>
  jwt.sign(
    { customerId: customer.id, email: customer.email, name: customer.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

const authenticateCustomer = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      customerId: payload.customerId,
      email: payload.email,
      name: payload.name,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = { signToken, authenticateCustomer, JWT_SECRET };
