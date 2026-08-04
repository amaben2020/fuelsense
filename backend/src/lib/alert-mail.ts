// Shared opt-in resolution for alert email.
//
// Preferences are per customer per alert type and default to OFF — a missing
// row means the manager never asked for this mail, so nothing is sent. The
// per-alert address wins over the account address when one is set.
import { db, customers, notificationPreferences, eq, and } from './db-helpers';
import { mailerReady } from './mailer';

/**
 * The address this alert type should go to, or null when it must not be sent
 * (mailer unconfigured, not opted in, or no address on file).
 */
export async function resolveAlertRecipient(
  customerId: string,
  alertType: string
): Promise<string | null> {
  if (!mailerReady()) return null;

  const [pref] = await db
    .select({
      enabled: notificationPreferences.emailEnabled,
      address: notificationPreferences.emailAddress,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.customerId, customerId),
        eq(notificationPreferences.alertType, alertType)
      )
    )
    .limit(1);

  if (!pref?.enabled) return null;
  if (pref.address) return pref.address;

  const [account] = await db
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  return account?.email ?? null;
}
