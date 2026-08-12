/**
 * Shrink a receipt photo until the OCR service will accept it.
 *
 * The provider's free tier refuses anything over 1 MB, and a modern phone
 * camera produces 3–8 MB. Enforcing that limit as a validation message left a
 * driver holding a receipt they could photograph but not log — the camera is
 * how a driver captures a receipt, so a limit the camera cannot meet is not a
 * limit, it is a broken feature.
 *
 * Downscaling costs almost nothing here. A receipt is high-contrast text on
 * white; the long edge only has to stay wide enough for the characters to
 * survive, and 1600 px is far more than a thermal till roll needs. Quality is
 * stepped down only if the size target is still missed after the resize, since
 * JPEG artefacts hurt OCR more than a smaller raster does.
 */

/** Comfortably inside the provider's 1 MB ceiling, with base64 overhead. */
const TARGET_BYTES = 700 * 1024;
const MAX_EDGE_PX = 1600;
/** Tried in order. Below ~0.5 the text edges start to mush. */
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.45];

/** Bytes represented by a base64 data URL, without decoding it. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode that image'));
    img.src = src;
  });
}

/**
 * Returns a data URL small enough to upload.
 *
 * If anything in the resize path fails — an exotic format, a browser without
 * canvas — the original is returned untouched rather than the capture being
 * lost. The server still has its own ceiling, so the worst case is the old
 * error message rather than a silent failure.
 */
export async function compressReceiptImage(file: File): Promise<string> {
  const original = await readAsDataUrl(file);
  if (dataUrlBytes(original) <= TARGET_BYTES) return original;

  try {
    const img = await loadImage(original);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(img.width, img.height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return original;
    // White underneath, so a transparent PNG does not flatten to black and
    // hide the very text we are trying to read.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let out = original;
    for (const quality of QUALITY_STEPS) {
      out = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlBytes(out) <= TARGET_BYTES) return out;
    }
    // Still over after the lowest quality step: send the smallest we produced
    // and let the server decide, rather than discarding the driver's photo.
    return out;
  } catch {
    return original;
  }
}
