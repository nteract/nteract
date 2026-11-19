// A catalog revision in the build's layout, an asset binding over it and an
// R2-shaped bucket in memory, for the library route and archive tests.
import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A two-file catalog (scripts/library-catalog.mjs layout): its revision,
 * manifest text, and each file's path → [bytes, content type]. */
export function catalogFixture({ module = "export const shout = (s) => s.toUpperCase();\n" } = {}) {
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const manifest =
    JSON.stringify(
      {
        imports: { shout: "shout.js" },
        files: { "shout.js": sha256(module), "sift.wasm": sha256(wasm) },
      },
      null,
      2,
    ) + "\n";
  const revision = sha256(manifest);
  const files = new Map([
    [
      `/catalog/${revision}/manifest.json`,
      [new TextEncoder().encode(manifest), "application/json"],
    ],
    [`/catalog/${revision}/shout.js`, [new TextEncoder().encode(module), "text/javascript"]],
    [`/catalog/${revision}/sift.wasm`, [wasm, "application/wasm"]],
  ]);
  return { revision, manifest, files };
}

/** An ASSETS binding over `files` (path → [body, content type]) with
 * single-page-application handling: a missing path answers the HTML shell.
 * `requests` records each path it was asked for. */
export function assetsBinding(files) {
  const requests = [];
  return {
    requests,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push({ pathname, method: request.method, cookie: request.headers.get("cookie") });
      const file = files.get(pathname);
      if (!file)
        return new Response("<!doctype html><title>Pages</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      return new Response(file[0], {
        headers: {
          "content-type": file[1],
          etag: '"asset"',
          "content-length": String(new Blob([file[0]]).size),
        },
      });
    },
  };
}

/** An R2-shaped bucket in memory. `calls` records each operation; setting
 * `fail` to a method name makes that method throw. */
export class Bucket {
  objects = new Map();
  calls = [];
  fail = null;
  #object(key) {
    const bytes = this.objects.get(key);
    return bytes && { key, size: bytes.length, httpEtag: `"r2-${bytes.length}"` };
  }
  async head(key) {
    this.calls.push(["head", key]);
    if (this.fail === "head") throw Error("bucket unavailable");
    return this.#object(key) ?? null;
  }
  async get(key) {
    this.calls.push(["get", key]);
    if (this.fail === "get") throw Error("bucket unavailable");
    const object = this.#object(key);
    return object ? { ...object, body: new Blob([this.objects.get(key)]).stream() } : null;
  }
  async put(key, bytes) {
    this.calls.push(["put", key]);
    if (this.fail === "put") throw Error("bucket unavailable");
    this.objects.set(key, new Uint8Array(bytes));
    return { key };
  }
}
