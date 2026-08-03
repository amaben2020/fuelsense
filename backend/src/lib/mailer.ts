// Outbound email via SendGrid.
//
// Sending never blocks ingestion: callers fire and forget, and any failure is
// logged rather than thrown, because a bounced notification must never cost us
// a telemetry record.
import sgMail from '@sendgrid/mail';

const API_KEY = process.env.SENDGRID_API_KEY || '';
const FROM = process.env.ALERT_EMAIL_FROM || 'alerts@fuelsense.ng';
// While the seeded accounts carry placeholder addresses, override every
// recipient so real mail lands somewhere real. Unset this in production.
const OVERRIDE_TO = process.env.ALERT_EMAIL_OVERRIDE || '';

if (API_KEY) sgMail.setApiKey(API_KEY);

export const mailerReady = (): boolean => Boolean(API_KEY);

/** Addresses that clearly cannot receive mail — seeds, examples, local-only. */
export function isDeliverable(address: string | null | undefined): boolean {
  if (!address) return false;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return false;
  return !/\.(local|test|invalid|example)$/i.test(address.split('@')[1] ?? '');
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail({ to, subject, text, html }: MailInput): Promise<boolean> {
  if (!API_KEY) {
    console.warn('[mailer] SENDGRID_API_KEY not set — skipping:', subject);
    return false;
  }

  const recipient = OVERRIDE_TO || to;
  if (!isDeliverable(recipient)) {
    console.warn(`[mailer] "${recipient}" is not a deliverable address — skipping.`);
    return false;
  }

  try {
    await sgMail.send({ to: recipient, from: FROM, subject, text, html: html ?? text });
    console.log(`[mailer] sent "${subject}" to ${recipient}`);
    return true;
  } catch (err) {
    const detail =
      (err as { response?: { body?: unknown } })?.response?.body ?? (err as Error).message;
    console.error('[mailer] send failed:', JSON.stringify(detail).slice(0, 400));
    return false;
  }
}

/** Shared shell so every alert email looks the same and stays readable in
 *  plain-text clients, which is what most phone notifications preview. */
export function alertEmail(opts: {
  title: string;
  lines: Array<[string, string]>;
  footer?: string;
}): { text: string; html: string } {
  const text = [
    opts.title,
    '',
    ...opts.lines.map(([k, v]) => `${k}: ${v}`),
    '',
    opts.footer ?? 'FuelSense',
  ].join('\n');

  const rows = opts.lines
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px">${k}</td>` +
        `<td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600">${v}</td></tr>`
    )
    .join('');

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
    <h2 style="margin:0 0 12px;font-size:17px;color:#111827">${opts.title}</h2>
    <table style="border-collapse:collapse">${rows}</table>
    <p style="margin:16px 0 0;font-size:12px;color:#9ca3af">${opts.footer ?? 'FuelSense'}</p>
  </div>`;

  return { text, html };
}
