import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { sendMail, mailerReady, isDeliverable } from '../lib/mailer';

const router = express.Router();

// Public and unauthenticated, so it is the one route a stranger can make the
// server send mail from. Kept deliberately tight.
const contactLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many enquiries from this address — please try again later.' },
});

const CONTACT_TO = process.env.CONTACT_EMAIL_TO || 'uzochukwubenamara@gmail.com';

const MAX_NAME = 120;
const MAX_MESSAGE = 4000;

const ENQUIRY_LABELS: Record<string, string> = {
  trackers: 'Buy trackers',
  setup: 'Set up my fleet',
  demo: 'See a demo',
  other: 'General enquiry',
};

/** Everything here is stranger-supplied and ends up in an HTML email. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.post('/', contactLimiter, async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? '').trim().slice(0, MAX_NAME);
  const email = String(req.body?.email ?? '').trim().slice(0, 255);
  const company = String(req.body?.company ?? '').trim().slice(0, MAX_NAME);
  const phone = String(req.body?.phone ?? '').trim().slice(0, 40);
  const fleetSize = String(req.body?.fleet_size ?? '').trim().slice(0, 40);
  const topicKey = String(req.body?.topic ?? 'other').trim();
  const message = String(req.body?.message ?? '').trim().slice(0, MAX_MESSAGE);

  if (!name || !message) {
    return res.status(400).json({ error: 'Name and message are required' });
  }
  if (!isDeliverable(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  const topic = ENQUIRY_LABELS[topicKey] ?? ENQUIRY_LABELS.other;

  if (!mailerReady()) {
    console.warn('[contact] SENDGRID_API_KEY not set — enquiry not delivered:', { name, email });
    return res.status(503).json({ error: 'Email is not configured yet — please try again later.' });
  }

  const lines = [
    ['Name', name],
    ['Email', email],
    ['Company', company || '—'],
    ['Phone', phone || '—'],
    ['Fleet size', fleetSize || '—'],
    ['Enquiry', topic],
  ];

  const text = [
    ...lines.map(([label, value]) => `${label}: ${value}`),
    '',
    message,
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px">
      <h2 style="margin:0 0 4px;font-size:18px">New FuelSense enquiry</h2>
      <p style="margin:0 0 16px;color:#666;font-size:13px">${esc(topic)}</p>
      <table style="border-collapse:collapse;font-size:14px;width:100%">
        ${lines
          .map(
            ([label, value]) =>
              `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(label)}</td>` +
              `<td style="padding:4px 0"><strong>${esc(value)}</strong></td></tr>`
          )
          .join('')}
      </table>
      <p style="margin:16px 0 0;white-space:pre-wrap;font-size:14px;line-height:1.6">${esc(
        message
      )}</p>
    </div>
  `;

  try {
    const sent = await sendMail({
      to: CONTACT_TO,
      subject: `FuelSense enquiry — ${topic} — ${name}`,
      text,
      html,
      // Enquiries go to a real inbox; the seed-account override must not eat them.
      bypassOverride: true,
    });

    if (!sent) {
      return res.status(502).json({ error: 'Could not send your message — please email us directly.' });
    }

    res.status(202).json({ ok: true });
  } catch (error) {
    console.error('[contact] failed:', (error as Error).message);
    res.status(500).json({ error: 'Could not send your message — please email us directly.' });
  }
});

export default router;
