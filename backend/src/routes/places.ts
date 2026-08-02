// Image proxy for Google Places photos.
//
// Deliberately unauthenticated: these URLs are consumed by <img src>, which
// cannot carry a bearer token. Nothing customer-specific is exposed — a photo
// reference is an opaque Google handle — and proxying keeps the API key on the
// server instead of embedding it in markup the browser can read.
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { fetchPlacePhoto, fetchStreetView } from '../lib/place-lookup';

const router = express.Router();

// These routes are public (an <img> cannot send a bearer token), so they get a
// far tighter cap than the global one. A manager clicking through stops loads a
// handful of images a minute; anything near this ceiling is not a person.
const imageLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many image requests, please slow down.' },
});

router.use(imageLimiter);

router.get('/photo', async (req: Request, res: Response) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  const maxWidth = Math.min(Math.max(Number(req.query.w) || 480, 80), 1200);

  if (!ref) {
    res.status(400).json({ error: 'ref is required' });
    return;
  }

  try {
    const photo = await fetchPlacePhoto(ref, maxWidth);
    if (!photo) {
      res.status(404).json({ error: 'Photo unavailable' });
      return;
    }
    // Places photos are immutable for a given reference — cache hard.
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    // Helmet defaults this to same-origin, which makes the browser discard the
    // image because the dashboard runs on a different origin to the API. The
    // request succeeds and the bytes arrive; without this they never render.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Image-Cache', photo.cached ? 'HIT' : 'MISS');
    res.send(photo.body);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/streetview', async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    res.status(400).json({ error: 'valid lat and lng are required' });
    return;
  }

  try {
    const img = await fetchStreetView(lat, lng);
    if (!img) {
      res.status(404).json({ error: 'No Street View imagery here' });
      return;
    }
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    // Helmet defaults this to same-origin, which makes the browser discard the
    // image because the dashboard runs on a different origin to the API. The
    // request succeeds and the bytes arrive; without this they never render.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Image-Cache', img.cached ? 'HIT' : 'MISS');
    res.send(img.body);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
