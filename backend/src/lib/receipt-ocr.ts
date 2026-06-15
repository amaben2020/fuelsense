import { parseReceiptText } from './receipt-parser';

const OCR_SPACE_ENDPOINT = 'https://api.ocr.space/parse/image';
const OCR_SPACE_DEMO_KEY = 'helloworld';

export function isOcrConfigured(): boolean {
  return true;
}

interface NormalizedDataUrl {
  dataUrl: string;
  byteLength: number;
}

export function normalizeDataUrl(imageDataUrl: string): NormalizedDataUrl {
  const raw = String(imageDataUrl || '').trim();
  const match = raw.match(/^data:(image\/[\w+.-]+);base64,(.+)$/i);
  if (match) {
    return {
      dataUrl: `data:${match[1]};base64,${match[2]}`,
      byteLength: Buffer.byteLength(match[2], 'base64'),
    };
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 64) {
    const base64 = raw.replace(/\s/g, '');
    return {
      dataUrl: `data:image/jpeg;base64,${base64}`,
      byteLength: Buffer.byteLength(base64, 'base64'),
    };
  }
  throw Object.assign(new Error('Invalid receipt image payload'), { status: 400 });
}

function getOcrSpaceApiKey(): string {
  return process.env.OCR_SPACE_API_KEY?.trim() || OCR_SPACE_DEMO_KEY;
}

interface OcrSpaceResult {
  ocr_text: string;
  line_count: number;
  provider: string;
}

async function extractTextWithOcrSpace(dataUrl: string): Promise<OcrSpaceResult> {
  const apiKey = getOcrSpaceApiKey();
  const body = new URLSearchParams({
    apikey: apiKey,
    base64Image: dataUrl,
    language: 'eng',
    OCREngine: '2',
    detectOrientation: 'true',
    scale: 'true',
    isTable: 'false',
  });

  const response = await fetch(OCR_SPACE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw Object.assign(new Error(`OCR service unavailable (${response.status})`), {
      status: 502,
    });
  }

  const payload = await response.json() as {
    IsErroredOnProcessing: boolean;
    ErrorMessage?: string[];
    ErrorDetails?: string;
    ParsedResults?: Array<{ ParsedText?: string }>;
  };

  if (payload.IsErroredOnProcessing) {
    const message =
      payload.ErrorMessage?.[0] ||
      payload.ErrorDetails ||
      'Receipt OCR failed — try again or enter manually';
    throw Object.assign(new Error(String(message)), { status: 422 });
  }

  const parsedResults = payload.ParsedResults || [];
  const ocrText = parsedResults
    .map((result) => result.ParsedText?.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!ocrText) {
    throw Object.assign(new Error('No text detected on receipt image'), { status: 422 });
  }

  return {
    ocr_text: ocrText,
    line_count: ocrText.split('\n').filter(Boolean).length,
    provider: apiKey === OCR_SPACE_DEMO_KEY ? 'ocr.space (demo)' : 'ocr.space',
  };
}

interface ScanHints {
  merchant_hint?: string;
}

export async function scanReceiptImage(imageDataUrl: string, hints: ScanHints = {}): Promise<unknown> {
  const { dataUrl, byteLength } = normalizeDataUrl(imageDataUrl);

  if (byteLength > 1024 * 1024) {
    throw Object.assign(new Error('Receipt image must be under 1MB for free OCR'), {
      status: 400,
    });
  }

  const ocr = await extractTextWithOcrSpace(dataUrl);
  const parsed = parseReceiptText(ocr.ocr_text, hints);

  return {
    ...parsed,
    ocr_text: ocr.ocr_text,
    ocr_provider: ocr.provider,
    ocr_line_count: ocr.line_count,
  };
}
