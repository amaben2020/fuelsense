// Tells the fleet manager the moment a driver files a fuel receipt.
//
// Mirrors lib/trip-notifier.ts: an in-app alert always, plus email only for a
// customer who has opted in. Both the station's identity and a picture of it
// are resolved from the coordinates the driver's phone captured at upload, so
// the manager can see where the fuel was actually bought without opening the
// app.
import {
  db,
  alerts,
  customers,
  notificationPreferences,
  eq,
  and,
} from './db-helpers';
import { sendMail, mailerReady, alertEmail } from './mailer';
import { lookupPlace } from './place-lookup';

export const RECEIPT_UPLOADED_ALERT = 'receipt_uploaded';

export interface ReceiptUploadContext {
  customerId: string;
  vehicleId: string;
  licensePlate: string;
  driverName?: string | null;
  /** What the driver typed or the OCR read off the receipt. */
  merchantName: string;
  merchantAddress?: string | null;
  liters: number;
  pricePerLiter: number;
  totalAmount: number;
  odometerKm?: number | null;
  transactionDate: Date;
  latitude?: string | null;
  longitude?: string | null;
  reconciliationStatus: string;
}

const naira = (n: number): string => `₦${Math.round(n).toLocaleString('en-NG')}`;

/** Google's map link for a coordinate — works in every mail client. */
function mapLink(lat: string, lng: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
}

/**
 * Raises the manager-facing alert for a newly filed receipt and, when opted
 * in, emails it. Never throws: a notification failure must not roll back a
 * receipt the driver has already submitted.
 */
export async function notifyReceiptUploaded(ctx: ReceiptUploadContext): Promise<void> {
  const station = ctx.merchantName?.trim() || 'an unnamed station';
  const driver = ctx.driverName?.trim() || 'A driver';

  try {
    await db.insert(alerts).values({
      customerId: ctx.customerId,
      vehicleId: ctx.vehicleId,
      alertType: RECEIPT_UPLOADED_ALERT,
      message:
        `${driver} filed a fuel receipt for ${ctx.licensePlate}: ` +
        `${ctx.liters.toFixed(1)}L at ${station} for ${naira(ctx.totalAmount)}.`,
      latitude: ctx.latitude ?? null,
      longitude: ctx.longitude ?? null,
    });
  } catch (err) {
    console.error('[receipt_notifier] alert insert failed:', err);
  }

  // Not awaited by the caller's critical path — see the route.
  await emailReceiptUploaded(ctx, station, driver).catch((err) =>
    console.error('[receipt_notifier] email failed:', err)
  );
}

async function emailReceiptUploaded(
  ctx: ReceiptUploadContext,
  station: string,
  driver: string
): Promise<void> {
  if (!mailerReady()) return;

  const [pref] = await db
    .select({
      enabled: notificationPreferences.emailEnabled,
      address: notificationPreferences.emailAddress,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.customerId, ctx.customerId),
        eq(notificationPreferences.alertType, RECEIPT_UPLOADED_ALERT)
      )
    )
    .limit(1);

  // No row means not opted in — notifications are never on by default.
  if (!pref?.enabled) return;

  const [account] = await db
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, ctx.customerId))
    .limit(1);

  const to = pref.address || account?.email;
  if (!to) return;

  // The driver's typed address is the first source of truth; the coordinate
  // lookup fills in what they left blank and supplies the photo. Degrades to
  // raw coordinates rather than holding up the email.
  let where = ctx.merchantAddress?.trim() || null;
  let photo: string | null = null;
  if (ctx.latitude && ctx.longitude) {
    const place = await lookupPlace(Number(ctx.latitude), Number(ctx.longitude)).catch(() => null);
    if (place) {
      where = where || place.formatted_address || place.place_name;
      photo = place.photo_url;
    }
    where = where || `${ctx.latitude}, ${ctx.longitude}`;
  }

  const { text, html } = alertEmail({
    title: `${ctx.licensePlate} — fuel receipt filed at ${station}`,
    imageUrl: photo,
    imageCaption: photo ? `${station}${where ? ` · ${where}` : ''}` : null,
    lines: [
      ['Vehicle', ctx.licensePlate],
      ['Driver', driver],
      ['Station', station],
      ['Location', where ?? 'Not captured'],
      ['Volume', `${ctx.liters.toFixed(2)} L`],
      ['Price/litre', naira(ctx.pricePerLiter)],
      ['Total', naira(ctx.totalAmount)],
      ...(ctx.odometerKm != null
        ? ([['Odometer', `${ctx.odometerKm.toLocaleString()} km`]] as Array<[string, string]>)
        : []),
      ['Filed', ctx.transactionDate.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })],
      ['Reconciliation', ctx.reconciliationStatus.replace(/_/g, ' ')],
    ],
    linkUrl: ctx.latitude && ctx.longitude ? mapLink(ctx.latitude, ctx.longitude) : null,
    linkLabel: 'See the station on the map',
    footer: 'FuelSense · turn these off in Settings → Notifications',
  });

  await sendMail({
    to,
    subject: `${ctx.licensePlate}: ${ctx.liters.toFixed(1)}L receipt from ${station}`,
    text,
    html,
  });
}
