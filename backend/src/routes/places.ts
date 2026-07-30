// Image proxy for Google Places photos.
//
// Deliberately unauthenticated: these URLs are consumed by <img src>, which
// cannot carry a bearer token. Nothing customer-specific is exposed — a photo
// reference is an opaque Google handle — and proxying keeps the API key on the
// server instead of embedding it in markup the browser can read.
import express, { Request, Response } from 'express';
import { fetchPlacePhoto } from '../lib/place-lookup';

const router = express.Router();

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
    res.send(Buffer.from(photo.body));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
