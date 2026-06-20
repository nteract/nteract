import { logger } from "@/lib/logger";

function dataUrlToBlob(src: string, fallbackType: string): Blob {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/i.exec(src);
  if (!match) {
    throw new Error("Invalid data URL");
  }

  const type = match[1] || fallbackType;
  const parameters = match[2] || "";
  const body = match[3] || "";
  const decoded = /;base64/i.test(parameters)
    ? atob(body.replace(/\s/g, ""))
    : decodeURIComponent(body);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }

  return new Blob([bytes], { type });
}

function ensureBlobType(blob: Blob, fallbackType: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: fallbackType });
}

async function sourceToBlob(src: string, mimeType: string): Promise<Blob> {
  if (/^data:/i.test(src)) {
    return dataUrlToBlob(src, mimeType);
  }

  const response = await fetch(src);
  return ensureBlobType(await response.blob(), mimeType);
}

// Browsers only reliably accept image/png in ClipboardItem; jpeg/gif/webp/bmp
// writes throw. Re-encode any non-PNG raster to PNG via a canvas so "copy image"
// works for every raster type, not just matplotlib's PNG.
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2d canvas context unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!png) {
      throw new Error("canvas toBlob produced no png");
    }
    return png;
  } finally {
    bitmap.close();
  }
}

export function copyRasterImageToClipboard(src: string, mimeType: string): void {
  try {
    // Resolve the PNG inside the ClipboardItem and call write() synchronously, so
    // the clipboard write stays inside the user gesture. Safari drops the
    // transient activation across an awaited fetch or canvas encode, which would
    // silently reject the write; passing a Promise<Blob> to ClipboardItem defers
    // that async work without leaving the gesture.
    const png = (async () => toPngBlob(await sourceToBlob(src, mimeType)))();
    void navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).catch((error) => {
      logger.warn("[copy-image] Failed to copy raster image:", error);
    });
  } catch (error) {
    logger.warn("[copy-image] Failed to copy raster image:", error);
  }
}
