const express = require('express');
const bcrypt = require('bcryptjs');
const {
  db,
  customers,
  customerPublicSelect,
  eq,
  serializeForApi,
} = require('../lib/db-helpers');
const { signToken, authenticateCustomer } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { name, email, password, companyName, phone } = req.body;

  if (!name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, email.toLowerCase().trim()));

    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
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

    const token = signToken(customer);
    res.status(201).json({ token, customer });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email?.trim() || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
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
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, customer.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    delete customer.password_hash;
    const token = signToken(customer);
    res.json({ token, customer });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/me', authenticateCustomer, async (req, res) => {
  try {
    const [customer] = await db
      .select(customerPublicSelect)
      .from(customers)
      .where(eq(customers.id, req.user.customerId));

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/onboarding', authenticateCustomer, async (req, res) => {
  try {
    const [customer] = await db
      .update(customers)
      .set({ onboardingCompleted: true, updatedAt: new Date() })
      .where(eq(customers.id, req.user.customerId))
      .returning(customerPublicSelect);

    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
