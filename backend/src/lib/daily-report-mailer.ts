// Sends the daily report, once per customer per day.
//
// Deduped through `report_runs` rather than an in-memory flag: this process
// restarts on every deploy, and a manager receiving the same report three times
// because we shipped at 6am would stop opening any of them.
import { db, sql } from './db-helpers';
import { sendMail, mailerReady } from './mailer';
import { buildDailyReport, DailyReport } from './daily-report';
import { renderDailyReportPdf, dailyReportFilename } from './daily-report-pdf';

/** Hour in Lagos time to send yesterday's report. */
const SEND_HOUR_WAT = Number(process.env.DAILY_REPORT_HOUR || 6);
/** Overrides every recipient. Useful while the fleet's own addresses are seeds. */
const REPORT_TO = process.env.DAILY_REPORT_TO || '';

const naira = (n: number): string => `₦${Math.round(n).toLocaleString('en-NG')}`;

/**
 * The email body.
 *
 * The PDF is the record; this is the glance. A manager who reads only the
 * subject line and the first three rows should already know whether anything
 * needs them today, which is why the totals are inline rather than "see
 * attached".
 */
export function reportEmailHtml(report: DailyReport): string {
  const day = report.date.toLocaleDateString('en-NG', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const t = report.totals;

  const driverRows = report.drivers
    .map(
      (d) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e8ecef;">
            <strong style="color:#101419;">${escapeHtml(d.driverName)}</strong><br />
            <span style="color:#6b7280;font-size:12px;">${escapeHtml(d.licensePlate)}</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e8ecef;text-align:right;color:#101419;">${d.distanceKm} km</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e8ecef;text-align:right;color:#101419;">${d.trips.length}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e8ecef;text-align:right;color:#101419;">${d.fuelLiters} L</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e8ecef;text-align:right;color:#101419;">${
            d.spendNgn > 0 ? naira(d.spendNgn) : '—'
          }</td>
        </tr>`
    )
    .join('');

  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#ffffff;">
    <h1 style="margin:0;font-size:20px;color:#101419;">${escapeHtml(report.customerName)}</h1>
    <p style="margin:4px 0 20px;color:#6b7280;font-size:14px;">Daily fleet report · ${day}</p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr>
        <td style="padding:12px;background:#f5f7f8;border-radius:6px;">
          <div style="font-size:12px;color:#6b7280;">Distance</div>
          <div style="font-size:20px;font-weight:600;color:#101419;">${t.distanceKm} km</div>
        </td>
        <td style="width:12px;"></td>
        <td style="padding:12px;background:#f5f7f8;border-radius:6px;">
          <div style="font-size:12px;color:#6b7280;">Fuel burned (est.)</div>
          <div style="font-size:20px;font-weight:600;color:#101419;">${t.fuelLiters} L</div>
        </td>
        <td style="width:12px;"></td>
        <td style="padding:12px;background:#f5f7f8;border-radius:6px;">
          <div style="font-size:12px;color:#6b7280;">Spent at pumps</div>
          <div style="font-size:20px;font-weight:600;color:#101419;">${
            t.spendNgn > 0 ? naira(t.spendNgn) : '—'
          }</div>
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">
          <th style="padding:6px 12px;">Driver</th>
          <th style="padding:6px 12px;text-align:right;">Distance</th>
          <th style="padding:6px 12px;text-align:right;">Trips</th>
          <th style="padding:6px 12px;text-align:right;">Fuel</th>
          <th style="padding:6px 12px;text-align:right;">Spent</th>
        </tr>
      </thead>
      <tbody>${driverRows || '<tr><td colspan="5" style="padding:12px;color:#6b7280;">No vehicle moved today.</td></tr>'}</tbody>
    </table>

    <p style="margin-top:20px;color:#6b7280;font-size:12px;line-height:1.5;">
      Every trip, with times and places, is in the attached PDF.
      Fuel burned is modelled from distance and idling — these vehicles carry no tank sensor —
      while fuel bought is what drivers logged at the pump.
    </p>
  </div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

export function reportEmailText(report: DailyReport): string {
  const t = report.totals;
  const lines = [
    `${report.customerName} — daily fleet report`,
    `${t.distanceKm} km · ${t.tripCount} trips · ${t.fuelLiters} L burned · ${
      t.spendNgn > 0 ? naira(t.spendNgn) : 'no fuel bought'
    }`,
    '',
  ];

  for (const d of report.drivers) {
    lines.push(
      `${d.driverName} (${d.licensePlate}): ${d.distanceKm} km, ${d.trips.length} trips, ${d.fuelLiters} L${
        d.spendNgn > 0 ? `, ${naira(d.spendNgn)} spent` : ''
      }`
    );
    for (const trip of d.trips) {
      const when = trip.startedAt.toLocaleTimeString('en-NG', {
        timeZone: 'Africa/Lagos',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      lines.push(
        `   ${when} · ${trip.distanceKm} km · ${trip.fuelLiters} L${
          trip.from && trip.to ? ` · ${trip.from} → ${trip.to}` : ''
        }`
      );
    }
    lines.push('');
  }

  lines.push('Full trip detail is in the attached PDF.');
  return lines.join('\n');
}

/** Build, render and send one customer's report. Returns false when skipped. */
export async function sendDailyReport(
  customerId: string,
  date: Date,
  recipient: string
): Promise<boolean> {
  const report = await buildDailyReport(customerId, date);
  if (!report) return false;

  const pdf = await renderDailyReportPdf(report);
  const day = date.toLocaleDateString('en-NG', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
  });

  return sendMail({
    to: REPORT_TO || recipient,
    subject: `${report.customerName} — fleet report for ${day}`,
    text: reportEmailText(report),
    html: reportEmailHtml(report),
    attachments: [
      { filename: dailyReportFilename(report), content: pdf, type: 'application/pdf' },
    ],
    // A daily report is addressed to a manager who asked for it; the seed-account
    // override must not silently redirect it.
    bypassOverride: true,
  });
}

async function alreadySent(customerId: string, day: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM report_runs
    WHERE customer_id = ${customerId} AND report_date = ${day} AND report_type = 'daily'
    LIMIT 1
  `);
  return rows.rows.length > 0;
}

/** Sends yesterday's report to every customer, once the hour has passed. */
export async function runDailyReports(now = new Date()): Promise<number> {
  if (!mailerReady()) return 0;

  // Lagos is UTC+1 with no daylight saving.
  const lagosNow = new Date(now.getTime() + 60 * 60 * 1000);
  if (lagosNow.getUTCHours() < SEND_HOUR_WAT) return 0;

  const reportDate = new Date(lagosNow.getTime() - 24 * 60 * 60 * 1000);
  const day = reportDate.toISOString().slice(0, 10);

  const customers = (
    await db.execute(sql`SELECT id, email FROM customers WHERE subscription_status = 'active'`)
  ).rows as Array<{ id: string; email: string }>;

  let sent = 0;

  for (const customer of customers) {
    if (await alreadySent(customer.id, day)) continue;

    const ok = await sendDailyReport(customer.id, reportDate, customer.email).catch((error) => {
      console.error('[daily_report] failed:', (error as Error).message);
      return false;
    });

    if (!ok) continue;

    await db.execute(sql`
      INSERT INTO report_runs (customer_id, report_date, report_type, sent_at)
      VALUES (${customer.id}, ${day}, 'daily', NOW())
      ON CONFLICT DO NOTHING
    `);
    sent += 1;
  }

  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startDailyReportScheduler(intervalMs = 15 * 60 * 1000): void {
  if (timer) return;

  const run = async () => {
    try {
      const sent = await runDailyReports();
      if (sent > 0) console.log(`[daily_report] sent ${sent} report(s)`);
    } catch (error) {
      console.error('[daily_report] scheduler failed:', (error as Error).message);
    }
  };

  timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
}
