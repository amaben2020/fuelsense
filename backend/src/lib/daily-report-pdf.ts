// The daily report as a PDF.
//
// Laid out for reading on a phone at 6am: the fleet's totals first, then one
// block per driver, each with its trips in the order they happened. No colour
// coding that a monochrome print would lose, and no figure without its unit.
import PDFDocument from 'pdfkit';
import { DailyReport, ReportDriver } from './daily-report';

const INK = '#101419';
const MUTED = '#6b7280';
const RULE = '#d8dee4';

const naira = (n: number): string => `NGN ${Math.round(n).toLocaleString('en-NG')}`;
const clock = (d: Date): string =>
  d.toLocaleTimeString('en-NG', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const duration = (minutes: number): string =>
  minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

export function dailyReportFilename(report: DailyReport): string {
  const day = report.date.toISOString().slice(0, 10);
  return `fuelsense-daily-${day}.pdf`;
}

export function renderDailyReportPdf(report: DailyReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const dayLabel = report.date.toLocaleDateString('en-NG', {
      timeZone: 'Africa/Lagos',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // --- header ------------------------------------------------------------
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(report.customerName);
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor(MUTED)
      .text(`Daily fleet report · ${dayLabel}`);
    doc.moveDown(1);

    // --- fleet totals ------------------------------------------------------
    const t = report.totals;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Fleet total');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor(INK);

    const summaryLines = [
      `${t.distanceKm} km covered across ${t.tripCount} trip${t.tripCount === 1 ? '' : 's'}`,
      `${t.fuelLiters} L estimated fuel burned${t.fuelCostNgn != null ? ` (${naira(t.fuelCostNgn)})` : ''}`,
      `${duration(t.idleMinutes)} idling with the engine running`,
    ];

    for (const line of summaryLines) doc.text(`• ${line}`);

    if (t.spendNgn > 0) {
      doc.text(
        `• ${naira(t.spendNgn)} spent on fuel — ${t.litersBought} L bought`
      );
    } else {
      doc.fillColor(MUTED).text('• No fuel purchased today').fillColor(INK);
    }

    // Burned and bought are different quantities and the gap confuses people
    // every time, so it is explained once, here, rather than left to inference.
    doc
      .moveDown(0.4)
      .fillColor(MUTED)
      .fontSize(8.5)
      .text(
        'Fuel burned is estimated from distance and idling — these vehicles have no tank sensor. Fuel bought is what drivers logged at the pump; the difference is still in the tank.'
      );

    doc.moveDown(1);
    rule(doc);

    // --- per driver --------------------------------------------------------
    for (const driver of report.drivers) {
      driverSection(doc, driver);
    }

    if (report.drivers.length === 0) {
      doc
        .moveDown(1)
        .fillColor(MUTED)
        .fontSize(10)
        .text('No vehicle moved and no fuel was logged on this day.');
    }

    doc
      .moveDown(1.5)
      .fillColor(MUTED)
      .fontSize(8)
      .text(
        'Distances come from the tracker odometer. Fuel is modelled, not measured. Times are West Africa Time.',
        { align: 'left' }
      );

    doc.end();
  });
}

function rule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.8);
}

function driverSection(doc: PDFKit.PDFDocument, driver: ReportDriver): void {
  // Keep a driver's heading with at least the first line of their trips.
  if (doc.y > doc.page.height - 160) doc.addPage();

  doc.moveDown(0.4);
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(`${driver.driverName}  ·  ${driver.licensePlate}`);

  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(MUTED)
    .text(
      [
        `${driver.distanceKm} km`,
        `${driver.fuelLiters} L burned${driver.fuelCostNgn != null ? ` (${naira(driver.fuelCostNgn)})` : ''}`,
        `${duration(driver.idleMinutes)} idle`,
        driver.receiptCount > 0
          ? `${naira(driver.spendNgn)} spent · ${driver.litersBought} L bought`
          : 'no fuel bought',
      ].join('   ·   ')
    );

  doc.moveDown(0.5);

  if (driver.trips.length === 0) {
    doc.fontSize(9.5).fillColor(MUTED).text('   Did not drive today.');
    doc.moveDown(0.5);
    return;
  }

  driver.trips.forEach((trip, index) => {
    if (doc.y > doc.page.height - 90) doc.addPage();

    const route =
      trip.from && trip.to
        ? `${trip.from} → ${trip.to}`
        : trip.from
          ? `from ${trip.from}`
          : trip.to
            ? `to ${trip.to}`
            : 'route not named';

    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .text(`${index + 1}. ${clock(trip.startedAt)}–${clock(trip.endedAt)}   ${route}`, {
        indent: 12,
      });

    const detail = [
      `${trip.distanceKm} km`,
      `${trip.fuelLiters} L`,
      trip.idleMinutes > 0 ? `${duration(trip.idleMinutes)} idle` : null,
      trip.stopCount > 0 ? `${trip.stopCount} stop${trip.stopCount === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join('  ·  ');

    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(detail, { indent: 24 });
    doc.moveDown(0.3);
  });

  doc.moveDown(0.4);
  rule(doc);
}
