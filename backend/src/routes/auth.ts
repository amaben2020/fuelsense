import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import {
  db,
  customers,
  customerPublicSelect,
  eq,
} from '../lib/db-helpers';
import { signToken, authenticateCustomer } from '../middleware/auth';

const router = express.Router();

router.post('/register', async (req: Request, res: Response) => {
  const { name, email, password, companyName, phone } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    companyName?: string;
    phone?: string;
  };

  if (!name?.trim() || !email?.trim() || !password) {
    res.status(400).json({ error: 'Name, email, and password are required' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, email.toLowerCase().trim()));

    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [customer] = await db
      .insert(customers)
      .values({
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        companyName: companyName?.trim() || null,
        phone: phone?.trim() || null,
      })
      .returning(customerPublicSelect);

    const token = signToken(customer as Parameters<typeof signToken>[0]);
    res.status(201).json({ token, customer });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email?.trim() || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  try {
    const [customer] = await db
      .select({
        ...customerPublicSelect,
        password_hash: customers.passwordHash,
      })
      .from(customers)
      .where(eq(customers.email, email.toLowerCase().trim()));

    if (!customer) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await bcrypt.compare(password, customer.password_hash as string);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const { password_hash: _ph, ...customerData } = customer;
    const token = signToken(customerData as Parameters<typeof signToken>[0]);
    res.json({ token, customer: customerData });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/me', authenticateCustomer, async (req: Request, res: Response) => {
  try {
    const [customer] = await db
      .select(customerPublicSelect)
      .from(customers)
      .where(eq(customers.id, req.user.customerId));

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.patch('/onboarding', authenticateCustomer, async (req: Request, res: Response) => {
  try {
    const [customer] = await db
      .update(customers)
      .set({ onboardingCompleted: true, updatedAt: new Date() })
      .where(eq(customers.id, req.user.customerId))
      .returning(customerPublicSelect);

    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
