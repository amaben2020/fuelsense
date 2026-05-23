const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const DRIVER_JWT_EXPIRES_IN = process.env.DRIVER_JWT_EXPIRES_IN || '30d';

const signToken = (customer) =>
  jwt.sign(
    { customerId: customer.id, email: customer.email, name: customer.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

const signDriverToken = (driver) =>
  jwt.sign(
    {
      role: 'driver',
      driverId: driver.id,
      customerId: driver.customerId,
      driverCode: driver.driverCode,
      name: driver.fullName,
    },
    JWT_SECRET,
    { expiresIn: DRIVER_JWT_EXPIRES_IN }
  );

const authenticateCustomer = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role === 'driver') {
      return res.status(403).json({ error: 'Driver token cannot access fleet routes' });
    }
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

const authenticateDriver = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'driver') {
      return res.status(403).json({ error: 'Fleet token cannot access driver routes' });
    }
    req.driver = {
      driverId: payload.driverId,
      customerId: payload.customerId,
      driverCode: payload.driverCode,
      name: payload.name,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = {
  signToken,
  signDriverToken,
  authenticateCustomer,
  authenticateDriver,
  JWT_SECRET,
};
