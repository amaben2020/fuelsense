import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import {
  db,
  customers,
  customerPublicSelect,
  eq,
} from '../lib/db-helpers';
import { signToken, authenticateCustomer } from '../middleware/auth';
import { logAndRespond } from '../lib/errors';

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});

router.post('/register', authLimiter, async (req: Request, res: Response) => {
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
    logAndRespond(res, req.path, error);
  }
});

router.post('/login', authLimiter, async (req: Request, res: Response) => {
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
    logAndRespond(res, req.path, error);
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
    logAndRespond(res, req.path, error);
  }
});

/**
 * White-label branding.
 *
 * A fleet operator reselling this to their own customers, or simply wanting
 * their own name over the door, sets a logo and accent colour here. Both are
 * optional; anything unset falls back to FuelSense's own mark, so a fresh
 * account still looks finished.
 */
router.patch('/branding', authenticateCustomer, async (req: Request, res: Response) => {
  const { logo_url: logoUrl, brand_color: brandColor, company_name: companyName } =
    req.body as { logo_url?: string | null; brand_color?: string | null; company_name?: string };

  // An arbitrary string here ends up in an <img src> on every page, so only
  // plain http(s) URLs are accepted — no data: or javascript: payloads.
  if (logoUrl && !/^https?:\/\/[^\s]+$/i.test(logoUrl)) {
    res.status(400).json({ error: 'logo_url must be an http(s) URL' });
    return;
  }

  if (brandColor && !/^#[0-9a-f]{3,8}$/i.test(brandColor)) {
    res.status(400).json({ error: 'brand_color must be a hex colour like #00e599' });
    return;
  }

  try {
    const [customer] = await db
      .update(customers)
      .set({
        ...(logoUrl !== undefined ? { logoUrl: logoUrl || null } : {}),
        ...(brandColor !== undefined ? { brandColor: brandColor || null } : {}),
        ...(companyName !== undefined ? { companyName: companyName?.trim() || null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, req.user.customerId))
      .returning(customerPublicSelect);

    res.json(customer);
  } catch (error) {
    logAndRespond(res, req.path, error);
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
    logAndRespond(res, req.path, error);
  }
});

export default router;
