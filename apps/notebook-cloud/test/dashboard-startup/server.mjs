import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  viewerThemeBootstrapScript,
  viewerThemeFirstPaintStyle,
} from "../../src/viewer-theme-bootstrap.ts";

// Manual visual regression fixture for the real built /n entrypoint. Each
// case owns its response gates; no real account, cookie, or service is used.
// Run from apps/notebook-cloud after build:viewer:
// node --import tsx test/dashboard-startup/server.mjs
const dist = resolve(process.env.DASHBOARD_FIXTURE_DIST ?? "dist");
const cases = new Map();
const session = {
  provider: "oidc",
  cache_key: "dashboard-fixture",
  expires_at: 9_999_999_999,
};
const notebooks = ["Climate observations", "Weekly analysis", "Shared experiment"].map(
  (title, index) => ({
    notebook_id: `fixture-${index}`,
    title,
    owner_principal: "user:dev:fixture",
    scope: index === 2 ? "editor" : "owner",
    created_at: "2026-09-01T12:00:00.000Z",
    updated_at: "2026-09-24T12:00:00.000Z",
    latest_revision_id: null,
    viewer_url: `/n/fixture-${index}`,
    endpoints: {
      catalog: `/api/n/fixture-${index}`,
      acl: `/api/n/fixture-${index}/acl`,
      access_requests: `/api/n/fixture-${index}/access-requests`,
    },
  }),
);
const body = { ok: true, notebooks, current_user_display: "Alex Example" };

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const referringUrl = new URL(req.headers.referer ?? url.href);
  const id = url.searchParams.get("case") ?? referringUrl.searchParams.get("case") ?? "manual";
  res.setHeader("Cache-Control", "no-store");
  if (!/^[\w-]+$/.test(id)) return res.writeHead(400).end();

  if (url.pathname.startsWith("/assets/")) {
    if (!/^\/assets\/[\w.-]+$/.test(url.pathname)) return res.writeHead(400).end();
    try {
      const bytes = await readFile(resolve(dist, url.pathname.slice(1)));
      res.setHeader(
        "Content-Type",
        extname(url.pathname) === ".css" ? "text/css" : "text/javascript",
      );
      return res.end(bytes);
    } catch {
      return res.writeHead(404).end();
    }
  }

  if (url.pathname === "/__fixture/release") {
    const state = cases.get(id);
    const stage = url.searchParams.get("stage");
    if (stage !== "session" && stage !== "list") return res.writeHead(400).end();
    state?.[stage].release();
    return res.end("released");
  }
  if (url.pathname.startsWith("/api/")) {
    const state = cases.get(id);
    if (!state) return res.writeHead(400).end();
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/auth/session") {
      await state.session.promise;
      return res.end(
        JSON.stringify({ ok: true, session: { ...session, display_name: "Alex Example" } }),
      );
    }
    if (url.pathname === "/api/n") {
      await state.list.promise;
      return res.end(JSON.stringify(body));
    }
    return res.writeHead(404).end("{}");
  }
  if (url.pathname !== "/n") return res.writeHead(404).end();

  const mode = url.searchParams.get("mode") ?? "fresh";
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  const state = { session: gate(), list: gate() };
  cases.set(id, state);
  if (mode !== "fresh") state.session.release();
  const authConfig =
    mode === "cached"
      ? { localDev: null, oidc: null }
      : {
          localDev: null,
          oidc: {
            flow: "server",
            issuer: "https://issuer.invalid",
            clientId: "fixture",
            redirectUri: "/oidc",
          },
        };
  const bootstrap =
    mode === "bootstrap"
      ? {
          kind: "notebook-list",
          session,
          notebooks,
          saved_at: "2026-09-24T12:00:00.000Z",
        }
      : null;
  const storage = {
    "nteract.cloud.viewer.theme": theme,
    ...(mode === "cached"
      ? {
          "nteract:notebook-cloud:dev-token": "fixture-only-not-a-credential",
          "nteract:notebook-cloud:user": "fixture",
          "nteract:notebook-cloud:scope": "owner",
        }
      : {}),
    // A prior account cache is deliberately present even in the fresh case.
    "nteract:notebook-cloud:notebook-list-cache:v2": JSON.stringify({
      v: 2,
      entries: [
        {
          principal: "user:dev:fixture",
          savedAt: 0,
          totalCount: notebooks.length,
          notebooks:
            mode === "cached"
              ? notebooks
              : [{ ...notebooks[0], title: "Prior account private notebook" }],
        },
      ],
    }),
  };
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Dashboard startup fixture</title>
    <script>
      // Replace storage with a per-document fixture, never inspect real storage.
      const values = new Map(Object.entries(${JSON.stringify(storage)}));
      Object.defineProperty(window, "localStorage", { value: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
      }});
    </script>
    <style>${viewerThemeFirstPaintStyle()}</style><script>${viewerThemeBootstrapScript()}</script>
    <link rel="stylesheet" href="/assets/notebook-cloud-viewer.css">
    </head><body><div id="root"></div>
    <script id="nteract-cloud-auth-config" type="application/json">${JSON.stringify(authConfig)}</script>
    ${bootstrap ? `<script id="nteract-cloud-bootstrap" type="application/json">${JSON.stringify(bootstrap)}</script>` : ""}
    <script type="module" src="/assets/notebook-cloud-viewer.js"></script>
    <aside aria-label="Fixture controls" style="position:fixed;bottom:8px;right:8px;z-index:100;background:Canvas;color:CanvasText;border:1px solid;padding:8px;font:12px system-ui">
      <button onclick="fetch('/__fixture/release?case=${id}&stage=session')">Resolve session</button> ·
      <button onclick="fetch('/__fixture/release?case=${id}&stage=list')">Resolve notebooks</button>
    </aside></body></html>`);
}).listen(5191, "127.0.0.1", () => {
  console.log("Dashboard fixture: http://127.0.0.1:5191/n?case=manual&mode=fresh");
});
