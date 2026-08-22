import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import {
  benchmarkPriceHistory,
  benchmarkChangeFraction,
  currentBenchmarkPrice,
  isNotableBenchmarkChange,
  setBenchmarkPrice,
  undoBenchmarkPrice,
  latestReceiptPrice,
} from '../lib/fuel-price';
import { serializeForApi } from '../lib/serialize';
import { invalidate } from '../lib/redis';
import { logAndRespond } from '../lib/errors';

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

    // Fuel price drives every naira figure in the product, so which way it is
    // moving is worth stating outright rather than leaving a manager to read it
    // off a list of dates. Oldest-first so a chart can plot it directly.
    const series = [...history].sort(
      (a, b) => new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime()
    );
    const first = series[0] ?? null;
    const last = series[series.length - 1] ?? null;
    const changeNgn = first && last ? last.ngnPerLiter - first.ngnPerLiter : 0;

    res.json(
      serializeForApi({
        current,
        latestReceipt: receipt,
        history,
        trend: {
          /** Every declared price, oldest first — the zigzag itself. */
          series: series.map((p) => ({
            ngnPerLiter: p.ngnPerLiter,
            effectiveFrom: p.effectiveFrom,
          })),
          changeNgn,
          changePct:
            first && first.ngnPerLiter > 0
              ? Math.round((changeNgn / first.ngnPerLiter) * 1000) / 10
              : 0,
          // A price that has only ever been declared once is flat, not rising:
          // with a single point there is no movement to describe.
          direction: series.length < 2 ? 'flat' : changeNgn > 0 ? 'up' : changeNgn < 0 ? 'down' : 'flat',
          changes: series.length,
          low: series.length ? Math.min(...series.map((p) => p.ngnPerLiter)) : null,
          high: series.length ? Math.max(...series.map((p) => p.ngnPerLiter)) : null,
        },
      })
    );
  } catch (error) {
    logAndRespond(res, req.path, error);
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
    const previous = await currentBenchmarkPrice(customerId);
    const saved = await setBenchmarkPrice(customerId, {
      ngnPerLiter: price,
      effectiveFrom,
      note,
    });

    // Every cost figure on the dashboard is derived from this.
    invalidate(customerId, 'fleet', 'summary', 'trips').catch(() => {});

    const changeFraction = benchmarkChangeFraction(price, previous);

    res.status(201).json(
      serializeForApi({
        ...saved,
        previous,
        changeFraction,
        notableChange: isNotableBenchmarkChange(changeFraction),
      })
    );
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

/**
 * Reverts the price change that was just made. Only works on the newest
 * period and only for a short window after it was set — see
 * `undoBenchmarkPrice` for why this isn't a general history editor.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  try {
    const customerId = req.user.customerId;
    const current = await undoBenchmarkPrice(customerId, id);

    invalidate(customerId, 'fleet', 'summary', 'trips').catch(() => {});

    res.json(serializeForApi(current));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

export default router;
