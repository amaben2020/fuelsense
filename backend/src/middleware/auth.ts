import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import type { JwtPayload, DriverJwtPayload } from '../types/index';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const DRIVER_JWT_EXPIRES_IN = process.env.DRIVER_JWT_EXPIRES_IN || '30d';

interface CustomerTokenInput {
  id: string;
  email: string;
  name: string;
}

interface DriverTokenInput {
  id: string;
  customerId: string;
  driverCode: string | null | undefined;
  fullName: string;
}

export const signToken = (customer: CustomerTokenInput): string =>
  jwt.sign(
    { customerId: customer.id, email: customer.email, name: customer.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions
  );

export const signDriverToken = (driver: DriverTokenInput): string =>
  jwt.sign(
    {
      role: 'driver',
      driverId: driver.id,
      customerId: driver.customerId,
      driverCode: driver.driverCode,
      name: driver.fullName,
    },
    JWT_SECRET,
    { expiresIn: DRIVER_JWT_EXPIRES_IN } as jwt.SignOptions
  );

export const authenticateCustomer = (req: Request, res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & { role?: string };
    if (payload.role === 'driver') {
      res.status(403).json({ error: 'Driver token cannot access fleet routes' });
      return;
    }
    req.user = {
      customerId: payload.customerId,
      email: payload.email,
      name: payload.name,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const authenticateDriver = (req: Request, res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as DriverJwtPayload;
    if (payload.role !== 'driver') {
      res.status(403).json({ error: 'Fleet token cannot access driver routes' });
      return;
    }
    req.driver = {
      driverId: payload.driverId,
      customerId: payload.customerId,
      driverCode: payload.driverCode,
      name: payload.name,
      role: 'driver',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export { JWT_SECRET };
