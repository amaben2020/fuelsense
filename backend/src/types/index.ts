export interface JwtPayload {
  customerId: string;
  email: string;
  name?: string;
  iat?: number;
  exp?: number;
}

export interface DriverJwtPayload {
  role: 'driver';
  driverId: string;
  customerId: string;
  driverCode: string;
  name: string;
  iat?: number;
  exp?: number;
}

// Extend Express Request to include authenticated user and driver
declare global {
  namespace Express {
    interface Request {
      user: JwtPayload;
      driver: DriverJwtPayload;
    }
  }
}
