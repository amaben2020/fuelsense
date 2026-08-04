import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import {
  benchmarkPriceHistory,
  currentBenchmarkPrice,
  setBenchmarkPrice,
  latestReceiptPrice,
} from '../lib/fuel-price';
import { serializeForApi } from '../lib/serialize';
import { invalidate } from '../lib/redis';

const router = express.Router();

router.use(authenticateCustomer);

// Nigerian pump prices have swung by more than half in a single year, so this
// is a figure the manager keeps current rather than something we can infer.
const MIN_PRICE_NGN = 50;
const MAX_PRICE_NGN = 20_000;

/** Current benchmark, the newest receipt price for comparison, and the history. */
router.get('/', async (req: Request, res: Response) => {
  try {
    const customerId = req.user.customerId;
    const [current, receipt, history] = await Promise.all([
      currentBenchmarkPrice(customerId),
      latestReceiptPrice(customerId),
      benchmarkPriceHistory(customerId),
    ]);

    res.json(
      serializeForApi({
        current,
        latestReceipt: receipt,
        history,
      })
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Declares a new price. This never edits an existing row — it opens a new
 * period, so figures already reported for earlier periods keep the price that
 * applied when the fuel was actually burned.
 */
router.post('/', async (req: Request, res: Response) => {
  const price = Number(req.body?.ngn_per_liter);
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
  const effectiveFromRaw = req.body?.effective_from;

  if (!Number.isFinite(price) || price < MIN_PRICE_NGN || price > MAX_PRICE_NGN) {
    return res
      .status(400)
      .json({ error: `ngn_per_liter must be between ${MIN_PRICE_NGN} and ${MAX_PRICE_NGN}` });
  }

  let effectiveFrom: Date | undefined;
  if (effectiveFromRaw != null) {
    const parsed = new Date(String(effectiveFromRaw));
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'effective_from is not a valid date' });
    }
    effectiveFrom = parsed;
  }

  try {
    const customerId = req.user.customerId;
    const saved = await setBenchmarkPrice(customerId, {
      ngnPerLiter: price,
      effectiveFrom,
      note,
    });

    // Every cost figure on the dashboard is derived from this.
    invalidate(customerId, 'fleet', 'summary', 'trips').catch(() => {});

    res.status(201).json(serializeForApi(saved));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
