// Sends one daily report on demand: `npx tsx src/send-daily-report.ts [YYYY-MM-DD] [email]`
//
// Kept as a script rather than an endpoint so a manager can be sent yesterday's
// report during a support call without exposing a way to trigger mail from the
// open internet.
import 'dotenv/config';
import './lib/timezone';
import { db, sql } from './lib/db-helpers';
import { sendDailyReport } from './lib/daily-report-mailer';

const main = async () => {
  const [dayArg, emailArg] = process.argv.slice(2);
  const date = dayArg ? new Date(`${dayArg}T12:00:00Z`) : new Date(Date.now() - 86_400_000);

  const customers = (
    await db.execute(sql`SELECT id, email, COALESCE(company_name, name) AS name FROM customers`)
  ).rows as Array<{ id: string; email: string; name: string }>;

  for (const customer of customers) {
    const to = emailArg || customer.email;
    const sent = await sendDailyReport(customer.id, date, to);
    console.log(`${customer.name}: ${sent ? `sent to ${to}` : 'not sent'}`);
  }

  process.exit(0);
};

void main();
