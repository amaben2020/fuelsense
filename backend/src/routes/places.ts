// Image proxy for Google Places photos.
//
// Deliberately unauthenticated: these URLs are consumed by <img src>, which
// cannot carry a bearer token. Nothing customer-specific is exposed — a photo
// reference is an opaque Google handle — and proxying keeps the API key on the
// server instead of embedding it in markup the browser can read.
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  fetchPlacePhoto,
  fetchStaticMap,
  fetchStreetView,
  suggestAddresses,
} from '../lib/place-lookup';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../middleware/auth';
import { logAndRespond } from '../lib/errors';

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
    logAndRespond(res, req.path, error);
  }
});

router.get('/staticmap', async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const fixLat = Number(req.query.flat);
  const fixLng = Number(req.query.flng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    res.status(400).json({ error: 'valid lat and lng are required' });
    return;
  }

  const fix =
    Number.isFinite(fixLat) && Number.isFinite(fixLng) && Math.abs(fixLat) <= 90
      ? { lat: fixLat, lng: fixLng }
      : null;

  try {
    const img = await fetchStaticMap(lat, lng, fix);
    if (!img) {
      res.status(404).json({ error: 'Map unavailable' });
      return;
    }
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Image-Cache', img.cached ? 'HIT' : 'MISS');
    res.send(img.body);
  } catch (error) {
    logAndRespond(res, req.path, error);
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
    logAndRespond(res, req.path, error);
  }
});

export default router;

// Address suggestions for the receipt form.
//
// Unlike the image proxies above this is a JSON endpoint a token can reach, so
// it is authenticated: autocomplete costs money per keystroke and should not
// be callable by anyone who finds the URL.
// Both a fleet manager and a driver reach the receipt form, and they carry
// different tokens. Chaining the two middlewares would not work: each replies
// 401/403 itself rather than deferring, so the first to run would answer for
// both. This verifies once and accepts either role.
const authenticateEither = (req: Request, res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

router.get('/autocomplete', authenticateEither, async (req: Request, res: Response) => {
  const query = String(req.query.q ?? '').trim().slice(0, 120);
  if (query.length < 3) return res.json([]);

  try {
    res.json(await suggestAddresses(query));
  } catch (error) {
    console.error('[places] autocomplete route failed:', (error as Error).message);
    // A dead suggestion list must never block a driver from typing the
    // address by hand, so this degrades to empty rather than erroring.
    res.json([]);
  }
});
