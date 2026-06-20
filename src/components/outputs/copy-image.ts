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

export async function copyRasterImageToClipboard(src: string, mimeType: string): Promise<void> {
  try {
    const blob = await sourceToBlob(src, mimeType);
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  } catch (error) {
    logger.warn("[copy-image] Failed to copy raster image:", error);
  }
}
