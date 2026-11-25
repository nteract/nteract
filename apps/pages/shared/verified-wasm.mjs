// Sift's wasm for the library catalog's @nteract/sift/parquet entry
// (scripts/library-catalog.mjs). A view's frame loads it from the library
// origin, which import map integrity doesn't cover: integrity applies to
// modules, not to the wasm a module fetches. The entry carries the wasm's
// sha256, so the catalog revision names these bytes too.

/** The wasm at `url` as a `data:` URL, read only when its bytes match
 * `integrity` (`sha256-<base64>`); the browser refuses the response
 * otherwise. Sift decodes a `data:` URL itself, since a frame's CSP refuses
 * fetching `blob:` URLs. */
export async function verifiedWasmUrl(url, integrity, fetchWasm = globalThis.fetch) {
  const response = await fetchWasm(url, { integrity, credentials: "omit" });
  if (!response.ok) throw Error(`Sift's wasm didn't load (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return "data:application/wasm;base64," + base64(bytes);
}

function base64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
