// A loopback proxy in front of a local celld that compresses like the
// Cloudflare edge (brotli for text and WASM), since celld dev serves static
// assets uncompressed and a throttled benchmark would otherwise measure bytes
// no user downloads. Rewrites Origin, Referer and redirects so the Worker's
// origin checks pass, and passes WebSocket upgrades through.
//
// With `http2: true` it serves HTTP/2 over TLS with a throwaway self-signed
// certificate (made with the openssl CLI; the browser must ignore certificate
// errors), as the edge does: one connection with request priorities, instead
// of HTTP/1.1's six connections per host. It passes no WebSocket through, so
// it suits pages that only make HTTP requests, such as the library.
//
// `viewer()` may name another build's `public` directory for the next
// requests: the proxy then serves that build's shell and hashed files itself
// and forwards everything else, so one fixture can compare viewer builds.
// Meanwhile it advertises the Worker's build as "dev" (X-Pages-Build and
// /health), which a viewer never counts as a different build, so no viewer
// shows "App updated" over the page it is measured on.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, constants as zlib } from "node:zlib";

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|wasm)|image\/svg)/;
// Connection-specific headers HTTP/2 forbids.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
};
// The viewer's hashed files (scripts/viewer-chunks.mjs) and the paths the
// shell answers with index.html.
const HASHED_FILE = /^\/(?:chunks\/[A-Z2-7]{8}\.js|[a-z]+-[A-Z2-7]{8}\.(?:js|css|wasm))$/;
const SHELL_PATH = /^\/(?:$|pages\/?$|projects\/?$|p\/|project\/)/;

function selfSignedCertificate() {
  const directory = mkdtempSync(path.join(tmpdir(), "pages-edge-proxy-"));
  try {
    const key = path.join(directory, "key.pem");
    const cert = path.join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Start the proxy for `origin`. Resolves `{ origin, close }`, where
 * `origin` is the proxy's own http(s)://localhost:<port>. */
export async function startEdgeProxy(origin, { http2: secure = false, viewer = () => null } = {}) {
  const upstream = new URL(origin);
  const brotliCache = new Map();
  let proxyOrigin;
  /** Answer with `body`, brotli-compressed when the client takes it. */
  const send = (request, response, status, headers, body) => {
    const type = String(headers["content-type"] || "");
    const wantsBrotli = /\bbr\b/.test(String(request.headers["accept-encoding"] || ""));
    if (!wantsBrotli || !COMPRESSIBLE.test(type) || headers["content-encoding"]) {
      response.writeHead(status, { ...headers, "content-length": body.length });
      response.end(body);
      return;
    }
    const key = request.url + "\0" + body.length;
    let compressed = brotliCache.get(key);
    if (!compressed || !body.equals(compressed.source)) {
      compressed = {
        source: body,
        bytes: brotliCompressSync(body, {
          params: {
            [zlib.BROTLI_PARAM_QUALITY]: 9,
            [zlib.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        }),
      };
      brotliCache.set(key, compressed);
    }
    response.writeHead(status, {
      ...headers,
      "content-encoding": "br",
      "content-length": compressed.bytes.length,
    });
    response.end(compressed.bytes);
  };
  /** A file from the chosen viewer build, or null to forward. */
  const viewerFile = (request) => {
    const root = request.method === "GET" ? viewer() : null;
    if (!root) return null;
    const { pathname } = new URL(request.url, "http://proxy.invalid");
    const name = SHELL_PATH.test(pathname)
      ? "index.html"
      : HASHED_FILE.test(pathname)
        ? pathname.slice(1)
        : null;
    const file = name && path.join(root, name);
    return file && existsSync(file) ? file : null;
  };
  const handle = (request, response) => {
    const file = viewerFile(request);
    if (file) {
      send(
        request,
        response,
        200,
        {
          "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
          "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000",
        },
        readFileSync(file),
      );
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !name.startsWith(":")),
    );
    headers.host = upstream.host;
    // The Worker checks Origin against its configured public origin.
    if (headers.origin) headers.origin = origin;
    if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, origin);
    delete headers["accept-encoding"];
    const forward = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        path: request.url,
        method: request.method,
        headers,
      },
      (reply) => {
        const type = String(reply.headers["content-type"] || "");
        const wantsBrotli = /\bbr\b/.test(String(request.headers["accept-encoding"] || ""));
        const replyHeaders = { ...reply.headers };
        if (secure) for (const name of HOP_BY_HOP) delete replyHeaders[name];
        if (replyHeaders.location)
          replyHeaders.location = replyHeaders.location.replace(origin, proxyOrigin);
        const otherViewer = viewer() !== null;
        if (otherViewer && replyHeaders["x-pages-build"]) replyHeaders["x-pages-build"] = "dev";
        if (otherViewer && new URL(request.url, "http://proxy.invalid").pathname === "/health") {
          const parts = [];
          reply.on("data", (part) => parts.push(part));
          reply.on("end", () => {
            const body = Buffer.from(
              Buffer.concat(parts)
                .toString("utf8")
                .replace(/"build":"[0-9a-f]{12}"/, '"build":"dev"'),
            );
            delete replyHeaders["content-length"];
            delete replyHeaders["transfer-encoding"];
            send(request, response, reply.statusCode, replyHeaders, body);
          });
          return;
        }
        if (!wantsBrotli || !COMPRESSIBLE.test(type) || reply.headers["content-encoding"]) {
          response.writeHead(reply.statusCode, replyHeaders);
          reply.pipe(response);
          return;
        }
        const parts = [];
        reply.on("data", (part) => parts.push(part));
        reply.on("end", () => {
          delete replyHeaders["content-length"];
          delete replyHeaders["transfer-encoding"];
          send(request, response, reply.statusCode, replyHeaders, Buffer.concat(parts));
        });
      },
    );
    forward.on("error", () => response.destroy());
    request.pipe(forward);
  };
  const proxy = secure
    ? http2.createSecureServer({ ...selfSignedCertificate(), allowHTTP1: true }, handle)
    : http.createServer(handle);
  proxy.on("upgrade", (request, socket, head) => {
    const target = net.connect(Number(upstream.port), upstream.hostname, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i];
        let value = request.rawHeaders[i + 1];
        if (/^host$/i.test(name)) value = upstream.host;
        if (/^origin$/i.test(name)) value = origin;
        lines.push(`${name}: ${value}`);
      }
      target.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      target.destroy();
    };
    target.on("error", close);
    socket.on("error", close);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyOrigin = `${secure ? "https" : "http"}://localhost:${proxy.address().port}`;
  return { origin: proxyOrigin, close: () => proxy.close() };
}
