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

export interface MailAttachment {
  filename: string;
  /** Raw bytes; base64 encoding for the API happens here, not at the call site. */
  content: Buffer;
  type: string;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
  /**
   * Ignore ALERT_EMAIL_OVERRIDE. The override exists because seeded accounts
   * carry placeholder addresses, but mail addressed to a real, known inbox —
   * a contact-form enquiry, say — must not be swallowed by it.
   */
  bypassOverride?: boolean;
}

export async function sendMail({
  to,
  subject,
  text,
  html,
  attachments,
  bypassOverride,
}: MailInput): Promise<boolean> {
  if (!API_KEY) {
    console.warn('[mailer] SENDGRID_API_KEY not set — skipping:', subject);
    return false;
  }

  const recipient = bypassOverride ? to : OVERRIDE_TO || to;
  if (!isDeliverable(recipient)) {
    console.warn(`[mailer] "${recipient}" is not a deliverable address — skipping.`);
    return false;
  }

  try {
    await sgMail.send({
      to: recipient,
      from: FROM,
      subject,
      text,
      html: html ?? text,
      ...(attachments?.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content.toString('base64'),
              type: a.type,
              disposition: 'attachment',
            })),
          }
        : {}),
    });
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
/** Alert copy carries user-supplied values (merchant names, driver names), so
 *  every interpolated field is escaped before it reaches the HTML body. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) URLs may become an <img src> or href. */
function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function alertEmail(opts: {
  title: string;
  lines: Array<[string, string]>;
  footer?: string;
  /** Rendered above the detail table — e.g. a photo of the filling station. */
  imageUrl?: string | null;
  imageCaption?: string | null;
  /** Optional "view it" link, e.g. the location on a map. */
  linkUrl?: string | null;
  linkLabel?: string | null;
}): { text: string; html: string } {
  const image = safeUrl(opts.imageUrl);
  const link = safeUrl(opts.linkUrl);

  const text = [
    opts.title,
    '',
    ...opts.lines.map(([k, v]) => `${k}: ${v}`),
    ...(link ? ['', `${opts.linkLabel ?? 'View'}: ${link}`] : []),
    '',
    opts.footer ?? 'FuelSense',
  ].join('\n');

  const rows = opts.lines
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px">${esc(k)}</td>` +
        `<td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600">${esc(v)}</td></tr>`
    )
    .join('');

  const imageBlock = image
    ? `<img src="${esc(image)}" alt="${esc(opts.imageCaption ?? 'Location')}" width="520"
         style="display:block;width:100%;max-width:520px;height:auto;border-radius:8px;margin:0 0 12px" />` +
      (opts.imageCaption
        ? `<p style="margin:0 0 12px;font-size:12px;color:#6b7280">${esc(opts.imageCaption)}</p>`
        : '')
    : '';

  const linkBlock = link
    ? `<p style="margin:16px 0 0"><a href="${esc(link)}"
         style="color:#2563eb;font-size:13px;font-weight:600">${esc(opts.linkLabel ?? 'View')}</a></p>`
    : '';

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
    <h2 style="margin:0 0 12px;font-size:17px;color:#111827">${esc(opts.title)}</h2>
    ${imageBlock}
    <table style="border-collapse:collapse">${rows}</table>
    ${linkBlock}
    <p style="margin:16px 0 0;font-size:12px;color:#9ca3af">${esc(opts.footer ?? 'FuelSense')}</p>
  </div>`;

  return { text, html };
}
