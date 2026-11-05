#!/usr/bin/env node
import {createHash} from "node:crypto";
import {link, mkdtemp, rm, writeFile} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {pathToFileURL} from "node:url";

export const WASM_PACK = Object.freeze({
  release: "https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.15.0/wasm-pack-v0.15.0-x86_64-unknown-linux-musl.tar.gz",
  api: "https://api.github.com/repos/wasm-bindgen/wasm-pack/releases/assets/420850440",
  size: 2881231,
  sha256: "c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a",
});

// Six download attempts, each with at most three redirects and a 60s deadline.
// Integrity failures are terminal; only transport failures change the source.
export function downloadStep(state, event) {
  if (state.phase === "fetching") {
    if (event === "verified") return {phase: "verified"};
    if (event === "refused") return {phase: "failed"};
    if (event === "retry") return state.attempt === 6
      ? {phase: "exhausted"}
      : {phase: "backoff", attempt: state.attempt + 1, source: "api"};
  }
  if (state.phase === "backoff" && event === "elapsed") return {...state, phase: "fetching"};
  return state;
}

/** Dependency injection is for offline tests; the CLI accepts only an output path.
 * URLs, size and hash cannot come from a PR payload or environment variable. */
export async function downloadWasmPack({fetch = globalThis.fetch, sleep: wait = sleep, expected = WASM_PACK} = {}) {
  let state = {phase: "fetching", attempt: 1, source: "release"};
  while (state.phase === "fetching") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let failure = "wasm-pack download refused";
    let event = "retry";
    let bytes;
    try {
      let url = WASM_PACK[state.source];
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetch(url, {
          headers: {Accept: "application/octet-stream"},
          credentials: "omit",
          redirect: "manual",
          signal: controller.signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          let next;
          try { next = new URL(response.headers.get("location")); } catch { /* Refuse absent or malformed redirects. */ }
          if (redirects === 3 || !next || next.protocol !== "https:" || next.username || next.password || next.port || next.hostname !== "release-assets.githubusercontent.com") {
            failure = "wasm-pack redirect refused";
            event = "refused";
            await response.body?.cancel();
            break;
          }
          await response.body?.cancel();
          url = next.href;
          continue;
        }
        if (response.status !== 200) {
          // Rate-limit evidence belongs to the API endpoint, never its asset
          // redirects. Retry-After classifies only; it cannot extend backoff.
          const retryAfter = response.headers.get("retry-after") ?? "";
          const apiRateLimit = response.status === 403 && url === WASM_PACK.api && (
            response.headers.get("x-ratelimit-remaining") === "0" ||
            (/^(0|[1-9]\d{0,3})$/.test(retryAfter) && Number(retryAfter) <= 3600)
          );
          event = apiRateLimit || [429, 500, 502, 503, 504].includes(response.status) || (response.status === 404 && state.source === "release") ? "retry" : "refused";
          await response.body?.cancel();
          break;
        }
        failure = "wasm-pack archive verification failed";
        const length = response.headers.get("content-length");
        if (!response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected.size))) {
          event = "refused";
          await response.body?.cancel();
          break;
        }
        const chunks = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > expected.size) {
              event = "refused";
              await reader.cancel();
              break;
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        if (event === "refused") break;
        bytes = Buffer.concat(chunks);
        event = size === expected.size && createHash("sha256").update(bytes).digest("hex") === expected.sha256
          ? "verified" : "refused";
        break;
      }
    } catch {
      // Fetch errors can contain signed redirect URLs. Never propagate them.
      if (event !== "refused") event = "retry";
    } finally { clearTimeout(timer); }
    state = downloadStep(state, event);
    if (state.phase === "verified") return bytes;
    if (state.phase === "failed") throw new Error(failure);
    if (state.phase === "exhausted") throw new Error("wasm-pack download attempts exhausted");
    await wait(1000 * 2 ** (state.attempt - 2));
    state = downloadStep(state, "elapsed");
  }
}

/** Publish in the destination filesystem without replacing existing paths.
 * Extraction belongs to the caller, after this verified download completes. */
export async function publishArchive(output, bytes) {
  const destination = resolve(output);
  const temporary = await mkdtemp(join(dirname(destination), ".wasm-pack-"));
  try {
    const file = join(temporary, basename(destination));
    await writeFile(file, bytes, {flag: "wx", mode: 0o600});
    await link(file, destination);
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("invalid arguments");
    await publishArchive(process.argv[2], await downloadWasmPack());
    console.log("Verified wasm-pack 0.15.0 archive");
  } catch {
    console.error("wasm-pack verified download failed");
    process.exitCode = 1;
  }
}
