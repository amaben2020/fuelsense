const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const {
  db,
  deviceOrders,
  payments,
  IMEI_PATTERN,
  eq,
  and,
  desc,
  sql,
} = require('../lib/db-helpers');

const router = express.Router();

router.use(authenticateCustomer);

const PRICE_PER_TRACKER_NGN = Number(process.env.PRICE_PER_TRACKER_NGN || 120000);

router.get('/', async (req, res) => {
  try {
    const rows = await db
      .select({
        id: deviceOrders.id,
        customer_id: deviceOrders.customerId,
        order_date: deviceOrders.orderDate,
        status: deviceOrders.status,
        device_imeis: deviceOrders.deviceImeis,
        quantity: deviceOrders.quantity,
        total_amount_ngn: deviceOrders.totalAmountNgn,
        shipping_address: deviceOrders.shippingAddress,
        created_at: deviceOrders.createdAt,
      })
      .from(deviceOrders)
      .where(eq(deviceOrders.customerId, req.user.customerId))
      .orderBy(desc(deviceOrders.createdAt));

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  const { quantity, shippingAddress } = req.body;
  const qty = Math.min(Math.max(Number(quantity) || 1, 1), 50);

  try {
    const reference = `fs_${Date.now()}_${req.user.customerId.slice(0, 8)}`;
    const totalAmount = qty * PRICE_PER_TRACKER_NGN;

    const [order] = await db
      .insert(deviceOrders)
      .values({
        customerId: req.user.customerId,
        quantity: qty,
        totalAmountNgn: totalAmount,
        shippingAddress: shippingAddress?.trim() || null,
        status: 'pending',
      })
      .returning({
        id: deviceOrders.id,
        customer_id: deviceOrders.customerId,
        order_date: deviceOrders.orderDate,
        status: deviceOrders.status,
        quantity: deviceOrders.quantity,
        total_amount_ngn: deviceOrders.totalAmountNgn,
        shipping_address: deviceOrders.shippingAddress,
        created_at: deviceOrders.createdAt,
      });

    const [payment] = await db
      .insert(payments)
      .values({
        customerId: req.user.customerId,
        amountNgn: totalAmount,
        reference,
        status: 'pending',
        paymentMethod: 'paystack',
      })
      .returning({
        id: payments.id,
        reference: payments.reference,
        amount_ngn: payments.amountNgn,
        status: payments.status,
      });

    res.status(201).json({
      order,
      payment,
      checkout: {
        amountNgn: totalAmount,
        quantity: qty,
        pricePerTrackerNgn: PRICE_PER_TRACKER_NGN,
        message:
          'Order created. Paystack integration is Phase 2 — mark as paid manually for now.',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/:id/ship', async (req, res) => {
  const { deviceImeis } = req.body;

  if (!Array.isArray(deviceImeis) || deviceImeis.length === 0) {
    return res.status(400).json({ error: 'deviceImeis array is required' });
  }

  for (const imei of deviceImeis) {
    if (!IMEI_PATTERN.test(imei)) {
      return res.status(400).json({ error: `Invalid IMEI: ${imei}` });
    }
  }

  try {
    const [order] = await db
      .update(deviceOrders)
      .set({ status: 'shipped', deviceImeis })
      .where(
        and(eq(deviceOrders.id, req.params.id), eq(deviceOrders.customerId, req.user.customerId))
      )
      .returning({
        id: deviceOrders.id,
        customer_id: deviceOrders.customerId,
        order_date: deviceOrders.orderDate,
        status: deviceOrders.status,
        device_imeis: deviceOrders.deviceImeis,
        quantity: deviceOrders.quantity,
        total_amount_ngn: deviceOrders.totalAmountNgn,
        shipping_address: deviceOrders.shippingAddress,
        created_at: deviceOrders.createdAt,
      });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
