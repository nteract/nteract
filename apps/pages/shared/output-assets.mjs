import {
  ESM_MEDIA_TYPE,
  CSS_MEDIA_TYPE,
  JSON_MEDIA_TYPE,
  BINARY_MEDIA_TYPE,
  WAV_MEDIA_TYPE,
  OUTPUT_MAX_BYTES,
} from "./anywidget-view.mjs";

// Validation is container validation, never execution. ESM is served only
// as an attachment; the opaque output frame is its sole execution surface.
export function inspectOutputAsset(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > OUTPUT_MAX_BYTES)
    throw Error("Output assets must be 1 byte to 5 MiB.");
  if (mediaType === ESM_MEDIA_TYPE || mediaType === CSS_MEDIA_TYPE) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.trim() || text.includes("\0"))
      throw Error("JavaScript and CSS must be UTF-8 source without NUL bytes.");
  } else if (mediaType === JSON_MEDIA_TYPE) {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw Error("Use a valid UTF-8 JSON file.");
    }
  } else if (mediaType === WAV_MEDIA_TYPE) {
    const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < 44 ||
      ascii(0, 4) !== "RIFF" ||
      ascii(8, 4) !== "WAVE" ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      throw Error("Use a complete RIFF/WAVE audio file.");
    let format = false,
      data = false,
      at = 12;
    while (at + 8 <= bytes.length) {
      const size = view.getUint32(at + 4, true),
        end = at + 8 + size;
      if (end > bytes.length) throw Error("Truncated WAV chunk.");
      if (ascii(at, 4) === "fmt ") {
        if (
          size < 16 ||
          ![1, 3].includes(view.getUint16(at + 8, true)) ||
          !view.getUint16(at + 10, true) ||
          !view.getUint32(at + 12, true)
        )
          throw Error("Use PCM or IEEE float WAV audio.");
        format = true;
      }
      if (ascii(at, 4) === "data" && size > 0) data = true;
      at = end + (size % 2);
    }
    if (!format || !data || at !== bytes.length)
      throw Error("WAV needs format and audio data chunks.");
  } else if (mediaType !== BINARY_MEDIA_TYPE) throw Error("Unsupported output asset type.");
  return { mime_type: mediaType };
}
