/** MIME classification and base64 decoding belong to the shared Rust WASM. */
export function createOutputPreparer({ prepareContent, putBlob }) {
  async function content(mime, value) {
    const prepared = prepareContent(mime, JSON.stringify(value));
    if (typeof prepared.inline === "string") return { inline: prepared.inline };
    const bytes = new Uint8Array(prepared.bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    // A manifest must never become visible before its referenced bytes exist.
    await putBlob({ hash, bytes, mediaType: mime });
    return { blob: hash, size: bytes.byteLength };
  }
  return async (outputs) => {
    const manifests = [];
    for (const output of outputs) {
      const manifest = { ...output, output_id: crypto.randomUUID() };
      switch (output.output_type) {
        case "stream":
          manifest.text = await content("text/plain", output.text);
          break;
        case "error":
          manifest.traceback = await content("application/json", output.traceback);
          break;
        case "display_data":
        case "execute_result":
          manifest.data = {};
          for (const [mime, value] of Object.entries(output.data)) {
            manifest.data[mime] = await content(mime, value);
          }
          break;
        default:
          throw new Error(`Output operation requires runtime routing: ${output.output_type}`);
      }
      manifests.push(manifest);
    }
    return manifests;
  };
}
