// Carries a driver's account of an alert back to the manager.
//
// An alert on its own is a question nobody answered: "left the depot zone at
// 19:40" tells a manager what happened and nothing about why. The driver knows
// why, and until now had no way to say so — the explaining happened by phone,
// off the record, or not at all. This closes that loop, so the alert a manager
// opens already carries the answer.
import { db, customers, eq, and, notificationPreferences } from './db-helpers';
import { sendMail, mailerReady, alertEmail } from './mailer';
import { alertDefinition } from './alert-catalogue';

interface ExplanationContext {
  customerId: string;
  alertType: string;
  alertMessage: string;
  plate: string;
  driverName: string;
  note: string;
}

/**
 * Emails the manager the driver's reply, honouring the same per-alert opt-in
 * the alert itself uses. A manager who does not want mail about geofence exits
 * does not want mail about explanations of geofence exits either.
 */
export async function notifyDriverExplanation(ctx: ExplanationContext): Promise<void> {
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
        eq(notificationPreferences.alertType, ctx.alertType)
      )
    )
    .limit(1);

  if (!pref?.enabled) return;

  const [account] = await db
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, ctx.customerId))
    .limit(1);

  const to = pref.address || account?.email;
  if (!to) return;

  const label = alertDefinition(ctx.alertType)?.label ?? ctx.alertType.replace(/_/g, ' ');

  const { text, html } = alertEmail({
    title: `${ctx.plate} — ${ctx.driverName} explained "${label}"`,
    imageUrl: null,
    imageCaption: null,
    lines: [
      ['Vehicle', ctx.plate],
      ['Driver', ctx.driverName],
      ['Alert', ctx.alertMessage],
      ['Their reason', ctx.note],
    ],
    linkUrl: null,
    linkLabel: null,
    footer: 'FuelSense · the alert is now closed · Settings → Notifications',
  });

  await sendMail({
    to,
    subject: `${ctx.plate}: ${ctx.driverName} explained the ${label.toLowerCase()}`,
    text,
    html,
  });
}
