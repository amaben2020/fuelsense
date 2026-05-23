import { parseDriverReceipt, ParseReceiptResponse } from '@/lib/driver-api';

export async function scanReceiptImage(imageDataUrl: string): Promise<{
  ocr_text: string;
  ocr_provider?: string;
  parsed: ParseReceiptResponse;
}> {
  const result = await parseDriverReceipt(imageDataUrl);
  return {
    ocr_text: result.ocr_text ?? '',
    ocr_provider: result.ocr_provider,
    parsed: result,
  };
}
