/**
 * Read embedded table bytes without a network request. A sandboxed host can
 * pass authenticated data as a data URL even when its CSP blocks fetch(data:).
 */
export async function tableResponse(url: string): Promise<Response> {
  if (!/^data:/i.test(url)) return fetch(url);

  const parsed = new URL(url);
  const content = parsed.pathname + parsed.search;
  const comma = content.indexOf(",");
  if (comma < 0) throw new Error("Invalid table data URL: missing comma");

  const metadata = content.slice(0, comma);
  const payload = content.slice(comma + 1);
  const base64 = /;base64$/i.test(metadata);
  const contentType = (base64 ? metadata.slice(0, -7) : metadata) || "text/plain;charset=US-ASCII";
  // URL parsing percent-encodes non-ASCII characters. Decode escapes as bytes,
  // not UTF-8, so percent-encoded binary Arrow/Parquet data also survives.
  const decoded = payload.replace(/%([\da-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const binary = base64 ? atob(decoded) : decoded;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, { headers: { "Content-Type": contentType } });
}
