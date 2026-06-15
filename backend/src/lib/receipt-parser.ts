const MERCHANT_PATTERNS = [
  /total\s*energies/i,
  /mobil/i,
  /nnpc/i,
  /mrs\s/i,
  /oando/i,
  /conoil/i,
  /forte\s*oil/i,
  /ar\/\s*mobil/i,
];

const KNOWN_MERCHANTS = [
  'TotalEnergies',
  'Mobil',
  'NNPC',
  'MRS',
  'Oando',
  'Conoil',
  'Forte Oil',
];

function parseNumericToken(raw: unknown): number | null {
  if (raw == null) return null;
  let token = String(raw).trim().replace(/\s/g, '');
  if (!token) return null;

  const hasComma = token.includes(',');
  const hasDot = token.includes('.');

  if (hasComma && hasDot) {
    token = token.replace(/,/g, '');
  } else if (hasComma && !hasDot) {
    const parts = token.split(',');
    token = parts.length === 2 && parts[1].length <= 2 ? `${parts[0]}.${parts[1]}` : token.replace(/,/g, '');
  }

  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

function pickMerchant(text: string): string | null {
  for (const pattern of MERCHANT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const idx = MERCHANT_PATTERNS.indexOf(pattern);
      return KNOWN_MERCHANTS[idx] ?? match[0];
    }
  }

  const stationLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /station|filling|petrol|energy|oil/i.test(line));
  if (stationLine) return stationLine.slice(0, 80);

  return null;
}

function valueOnNextLines(lines: string[], startIndex: number, matcher: RegExp, maxLookahead = 6): number | null {
  for (let i = startIndex + 1; i < Math.min(startIndex + maxLookahead, lines.length); i++) {
    const line = lines[i];
    if (!line || /^(payment|method|change|thank|customer)/i.test(line)) continue;
    const match = line.match(matcher);
    if (match) return parseNumericToken(match[1]);
  }
  return null;
}

function parseLiters(text: string): number | null {
  const normalized = text.replace(/(\d)\s+\.\s+(\d)/g, '$1.$2');
  const lines = normalized.split('\n').map((line) => line.trim());

  for (let i = 0; i < lines.length; i++) {
    if (/volume\s*dispensed/i.test(lines[i])) {
      const nearby = valueOnNextLines(lines, i, /(\d+(?:[.,]\d+)?)\s*l/i);
      if (nearby != null) return nearby;
    }
  }

  const patterns = [
    /volume\s*dispensed[:\s]*(\d+(?:[.,]\d+)?)\s*l/i,
    /(?:volume|qty|quantity)[:\s]*(\d+(?:[.,]\d+)?)\s*l/i,
    /(?:litre?s?|ltrs?)[:\s]*(\d+(?:[.,]\d+)?)\s*l/i,
    /(\d+(?:[.,]\d+)?)\s*(?:litre?s?|ltrs?)\b/i,
    /(\d+(?:[.,]\d+)?)\s*L(?:TR)?/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return parseNumericToken(match[1]);
  }
  return null;
}

function parseAmount(text: string): number | null {
  const lines = text.split('\n').map((line) => line.trim());

  for (let i = 0; i < lines.length; i++) {
    if (/change|amount\s*paid|sub\s*total|payment|method/i.test(lines[i])) continue;

    if (/^total\b/i.test(lines[i])) {
      const inline = lines[i].match(/total\b[:\s]*(?:₦|ngn|n)?\s*([\d,]+(?:\.\d+)?)/i);
      if (inline) return parseNumericToken(inline[1]);
      const nearby = valueOnNextLines(lines, i, /^(?:₦|ngn|n)?\s*([\d,]+(?:\.\d+)?)$/i);
      if (nearby != null) return nearby;
    }
  }

  for (const line of lines) {
    if (/change|amount\s*paid|sub\s*total/i.test(line)) continue;
    const totalMatch = line.match(/^\s*total\b[:\s]*(?:₦|ngn|n)?\s*([\d,]+(?:\.\d+)?)/i);
    if (totalMatch) return parseNumericToken(totalMatch[1]);
  }

  const currencyMatches = [...text.matchAll(/(?:₦|ngn|n)\s*([\d,]+(?:\.\d+)?)/gi)];
  if (currencyMatches.length > 0) {
    const values = currencyMatches
      .map((m) => parseNumericToken(m[1]))
      .filter((v): v is number => v != null && v > 0);
    if (values.length > 0) {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
  }

  return null;
}

function parsePricePerLiter(text: string, liters: number | null, total: number | null): number | null {
  const normalized = text.replace(/(\d)\s+\.\s+(\d)/g, '$1.$2');

  const slashPatterns = [
    /(?:₦|ngn|n)\s*([\d,]+(?:\.\d+)?)\s*\/\s*l/i,
    /([\d,]+(?:\.\d+)?)\s*\/\s*l/i,
  ];
  for (const pattern of slashPatterns) {
    const match = normalized.match(pattern);
    if (match) return parseNumericToken(match[1]);
  }

  const lines = normalized.split('\n').map((line) => line.trim());

  for (let i = 0; i < lines.length; i++) {
    if (/unit\s*price|price\s*\/\s*l|p\/l/i.test(lines[i])) {
      const nearby = valueOnNextLines(
        lines,
        i,
        /(?:₦|ngn|n)?\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*l|per\s*l)?/i
      );
      if (nearby != null && nearby >= 100) return nearby;
    }
  }

  const patterns = [
    /unit\s*price[:\s]*(?:₦|ngn|n)?\s*([\d,]+(?:\.\d+)?)/i,
    /(?:price|rate|p\/l|per\s*litre?)[:\s]*(?:₦|ngn|n)?\s*([\d,]+(?:\.\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return parseNumericToken(match[1]);
  }
  if (liters && total) return Math.round((total / liters) * 100) / 100;
  return null;
}

function normalizeTotal(parsedTotal: number | null, liters: number | null, pricePerLiter: number | null): number | null {
  if (!liters || !pricePerLiter) return parsedTotal;
  const derived = Math.round(liters * pricePerLiter);
  if (parsedTotal == null) return derived;
  const within = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1) < 0.08;
  if (within(parsedTotal, derived)) return derived;
  if (!within(parsedTotal, derived)) return derived;
  return parsedTotal;
}

export function normalizeLiters(parsedLiters: number | null, total: number | null, pricePerLiter: number | null): number | null {
  if (pricePerLiter && pricePerLiter > 0 && total && total > 0) {
    const derived = Math.round((total / pricePerLiter) * 100) / 100;
    const within = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 0.01) < 0.12;

    if (parsedLiters == null) return derived;

    if (within(parsedLiters, derived)) return derived;

    if (parsedLiters > derived * 3) {
      for (const div of [10, 100]) {
        const candidate = Math.round((parsedLiters / div) * 100) / 100;
        if (within(candidate, derived)) return candidate;
      }
      return derived;
    }

    if (parsedLiters > 150) return derived;
  }

  return parsedLiters;
}

function parseTimestamp(text: string): Date | null {
  const iso = text.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/);
  if (iso) return new Date(iso[0].replace(' ', 'T'));

  const dmy = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]) - 1;
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    const hour = Number(dmy[4] ?? 0);
    const minute = Number(dmy[5] ?? 0);
    const second = Number(dmy[6] ?? 0);
    return new Date(year, month, day, hour, minute, second);
  }

  return null;
}

function parseAddress(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const addressLine = lines.find(
    (line) =>
      /\blagos\b|\bikeja\b|\broad\b|\bstreet\b|\bavenue\b|\bvi\b|\bapapa\b|\bexpressway\b/i.test(line) &&
      line.length > 8
  );
  return addressLine ?? null;
}

interface ParseHints {
  merchant_hint?: string;
}

interface ParsedReceiptFields {
  merchant_name: string | null;
  merchant_address: string | null;
  declared_liters: number | null;
  total_amount: number | null;
  price_per_liter: number | null;
  transaction_date: string;
}

interface ParseReceiptResult {
  fields: ParsedReceiptFields;
  confidence: Record<string, number>;
  parse_confidence: number;
  raw_text_preview: string;
}

export function parseReceiptText(ocrText: string, hints: ParseHints = {}): ParseReceiptResult {
  const text = String(ocrText || '').trim();
  const confidence: Record<string, number> = { merchant: 0, liters: 0, total: 0, timestamp: 0, address: 0 };

  let merchant = hints.merchant_hint ?? pickMerchant(text);
  if (merchant) confidence.merchant = hints.merchant_hint ? 0.9 : 0.75;

  let total = parseAmount(text);
  if (total != null) confidence.total = 0.8;

  let liters = parseLiters(text);
  let pricePerLiter = parsePricePerLiter(text, liters, total);
  if (pricePerLiter != null) confidence.total = Math.max(confidence.total, 0.7);

  if (pricePerLiter == null && liters && total) {
    pricePerLiter = Math.round((total / liters) * 100) / 100;
  }

  total = normalizeTotal(total, liters, pricePerLiter);
  if (total != null) confidence.total = Math.max(confidence.total, 0.8);

  const normalizedLiters = normalizeLiters(liters, total, pricePerLiter);
  if (normalizedLiters != null) {
    liters = normalizedLiters;
    confidence.liters = liters !== parseLiters(text) ? 0.92 : 0.85;
  }

  if (total == null && liters && pricePerLiter) {
    total = Math.round(liters * pricePerLiter);
    confidence.total = Math.max(confidence.total, 0.75);
  }

  if (pricePerLiter == null && liters && total) {
    pricePerLiter = Math.round((total / liters) * 100) / 100;
  }

  let transactionDate = parseTimestamp(text);
  if (transactionDate) confidence.timestamp = 0.8;
  else {
    transactionDate = new Date();
    confidence.timestamp = 0.3;
  }

  const merchantAddress = parseAddress(text);
  if (merchantAddress) confidence.address = 0.7;

  if (!merchant) {
    merchant = 'Fuel station';
    confidence.merchant = 0.2;
  }

  const fields: ParsedReceiptFields = {
    merchant_name: merchant,
    merchant_address: merchantAddress,
    declared_liters: liters,
    total_amount: total,
    price_per_liter: pricePerLiter,
    transaction_date: transactionDate.toISOString(),
  };

  const overall =
    Object.values(confidence).reduce((sum, v) => sum + v, 0) / Object.keys(confidence).length;

  return {
    fields,
    confidence,
    parse_confidence: Math.round(overall * 100),
    raw_text_preview: text.slice(0, 400),
  };
}

export { parseNumericToken };
