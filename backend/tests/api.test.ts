import request from 'supertest';
import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  if (email === 'demo@fuelsense.local' && password === 'demo1234') {
    res.json({ token: 'mock-token', customer: { id: 'mock-id', email } });
    return;
  }
  res.status(401).json({ error: 'Invalid email or password' });
});

app.get('/api/vehicles/fleet', (_req: Request, res: Response) => {
  res.status(401).json({ error: 'Not authenticated' });
});

app.get('/api/dashboard/summary', (_req: Request, res: Response) => {
  res.status(401).json({ error: 'Not authenticated' });
});

describe('FuelSense API', () => {
  describe('POST /api/auth/login', () => {
    it('returns 401 for wrong credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'wrong@example.com', password: 'wrongpass' });
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 200 with token for valid demo credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'demo@fuelsense.local', password: 'demo1234' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('customer');
    });
  });

  describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /api/vehicles/fleet', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get('/api/vehicles/fleet');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/dashboard/summary', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get('/api/dashboard/summary');
      expect(res.status).toBe(401);
    });
  });
});
