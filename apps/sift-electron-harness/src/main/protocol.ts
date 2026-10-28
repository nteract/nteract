/**
 * The `harness://` scheme: `harness://app/…` and `harness://embedded/…` both
 * serve `dist/renderer`, each with its own Kilo Desktop CSP. Mirrors KD's
 * `ElectronProtocol` (privileges, MIME table, path check, header wrapping) for
 * the parts that decide whether Sift loads; KD's dev-server proxy, plugin
 * schemes, and embedded-host routes are not reproduced.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { protocol } from "electron";

import { createContentSecurityPolicy, createEmbeddedContentSecurityPolicy } from "./csp";

export const SCHEME = "harness";
export const APP_HOST = "app";
export const EMBEDDED_HOST = "embedded";
export const APP_ORIGIN = `${SCHEME}://${APP_HOST}`;
export const EMBEDDED_ORIGIN = `${SCHEME}://${EMBEDDED_HOST}`;

// KD's table, trimmed to what the renderer bundle ships.
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  // Streaming WebAssembly compilation rejects anything but this exact type.
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Call before `app.whenReady()`. Same privileges as KD's app scheme. */
export function registerHarnessScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** `undefined` for anything that is not a file inside `root` (traversal, NUL, missing). */
export async function resolveRendererPath(
  root: string,
  requestPathname: string,
): Promise<string | undefined> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPathname);
  } catch {
    return undefined;
  }
  if (decodedPath.includes("\0")) return undefined;
  const relativePath = decodedPath.replace(/^\/+/, "") || "index.html";
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, relativePath);
  if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return undefined;
  }
  try {
    if ((await stat(filePath)).isFile()) return filePath;
  } catch {
    // Missing or unreadable.
  }
  return undefined;
}

function inlineScriptHashes(document: string): string[] {
  return [...document.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    ([, source]) =>
      createHash("sha256")
        .update(source ?? "")
        .digest("base64"),
  );
}

type PolicyBuilder = (hashes: readonly string[]) => string;

async function withSecurityHeaders(response: Response, policy: PolicyBuilder): Promise<Response> {
  const headers = new Headers(response.headers);
  let body: BodyInit | null = response.body;
  let hashes: string[] = [];
  if (headers.get("Content-Type")?.toLowerCase().includes("text/html")) {
    const bytes = await response.arrayBuffer();
    body = bytes;
    hashes = inlineScriptHashes(new TextDecoder().decode(bytes));
  }
  headers.set("Content-Security-Policy", policy(hashes));
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export function handleHarnessScheme(rendererRoot: string): void {
  const appPolicy: PolicyBuilder = (hashes) =>
    createContentSecurityPolicy(undefined, hashes, [EMBEDDED_ORIGIN], []);
  const embeddedPolicy: PolicyBuilder = (hashes) =>
    createEmbeddedContentSecurityPolicy(APP_ORIGIN, hashes);

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const policy =
      url.host === APP_HOST ? appPolicy : url.host === EMBEDDED_HOST ? embeddedPolicy : null;
    if (!policy) return withSecurityHeaders(new Response(null, { status: 404 }), appPolicy);
    const filePath = await resolveRendererPath(rendererRoot, url.pathname);
    if (!filePath) return withSecurityHeaders(new Response(null, { status: 404 }), policy);
    const body = Uint8Array.from(await readFile(filePath));
    return withSecurityHeaders(
      new Response(body, { headers: { "Content-Type": contentTypeFor(filePath) } }),
      policy,
    );
  });
}
