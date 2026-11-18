// Local celld companion. Only catalog assets and the isolated output shell
// are exposed on this loopback listener.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { FRAME_HTML } from "../../.output-dist/frame-html.mjs";
import worker, { FRAME_CSP } from "../../output/worker.mjs";
import { OUTPUT_FRAME_PATH } from "../../shared/output-frame-paths.mjs";

const app = fileURLToPath(new URL("../../", import.meta.url));
const root = path.resolve(app, "../..");
const dir = path.join(app, ".output-dist/catalog");
const port = Number(process.env.PAGES_CATALOG_PORT || 9446);
const origin = `http://127.0.0.1:${port}`;
const uiDir = path.join(root, "src/components/ui");
const entries = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "d3",
  "@observablehq/plot",
  "@nteract/pages-ui",
];
const nameOf = (id) => id.replace(/^@/, "").replaceAll("/", "-");
const requireFromApp = createRequire(path.join(app, "package.json"));
const result = await build({
  absWorkingDir: app,
  entryPoints: entries.map((id) => ({ in: `catalog:${id}`, out: nameOf(id) })),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  outdir: dir,
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "@": path.join(root, "src"),
    react: path.join(app, "node_modules/react"),
    "react-dom": path.join(app, "node_modules/react-dom"),
  },
  plugins: [
    {
      name: "catalog-entries",
      setup(plugin) {
        plugin.onResolve({ filter: /^catalog:/ }, ({ path }) => ({
          path: path.slice(8),
          namespace: "catalog",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "catalog" }, ({ path: id }) => {
          let contents;
          if (id === "@nteract/pages-ui") {
            contents = ["toggle-group", "separator"]
              .map((name) => `export * from ${JSON.stringify(path.join(uiDir, name + ".tsx"))}`)
              .join("\n");
          } else if (id.startsWith("react")) {
            // Publish CJS React entry points as real named ESM exports. All
            // importers resolve the same React module within the split graph.
            const names = Object.keys(requireFromApp(id)).filter((name) =>
              /^[a-zA-Z_$][\w$]*$/.test(name),
            );
            contents = `import api from '${id}'; export default api; export const {${names.join(",")}} = api;`;
          } else {
            contents = `export * from '${id}';`;
          }
          return { contents, resolveDir: app };
        });
      },
    },
  ],
});
const files = new Map(result.outputFiles.map((f) => [path.basename(f.path), f.contents]));
const theme = await readFile(requireFromApp.resolve("tailwindcss/theme.css"), "utf8");
const colors = [
  "border",
  "input",
  "accent",
  "accent-foreground",
  "ring",
  "muted",
  "muted-foreground",
];
const compiler = await compile(
  theme +
    "\n@theme inline {" +
    colors.map((c) => `--color-${c}:var(--${c});`).join("") +
    "} @tailwind utilities;",
);
const candidates = [];
for (const file of ["toggle", "toggle-group", "separator"]) {
  const source = await readFile(path.join(uiDir, file + ".tsx"), "utf8");
  for (const [, literal] of source.matchAll(/"([^"\n]+)"/g))
    candidates.push(...literal.split(/\s+/));
}
// The frame's native button defaults pair a filled primary background with
// primary-foreground. Radix toggles have transparent unselected backgrounds.
const toggleBase =
  "button:where([data-radix-collection-item][data-state=off]) {color: var(--foreground)}";
files.set("components.css", Buffer.from(toggleBase + "\n" + compiler.build(candidates)));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifest =
  JSON.stringify(
    {
      imports: Object.fromEntries(entries.map((id) => [id, nameOf(id) + ".js"])),
      stylesheet: "components.css",
      files: Object.fromEntries(
        [...files]
          .map(([name, data]) => [name, hash(data)])
          .sort(([a], [b]) => a.localeCompare(b, "en")),
      ),
    },
    null,
    2,
  ) + "\n";
const pin = hash(manifest);
const directory = path.join(dir, pin);
await mkdir(directory, { recursive: true });
for (const [name, data] of files) await writeFile(path.join(directory, name), data);
await writeFile(path.join(directory, "manifest.json"), manifest);
const server = createServer(async (req, res) => {
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  if (!["GET", "HEAD"].includes(req.method)) return send(405, "text/plain", "Use GET");
  try {
    const url = new URL(req.url, origin);
    const asset = /^\/catalog\/([a-f0-9]{64})\/([\w-]+\.(?:js|css|json))$/.exec(url.pathname);
    if (asset || url.pathname === "/catalog.json") {
      const [, revision, name] = asset ?? [null, pin, "manifest.json"];
      const data = await readFile(path.join(dir, revision, name));
      return send(
        200,
        name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : "application/json",
        data,
        {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-store",
        },
      );
    }
    const revision = url.searchParams.get("catalog");
    if (url.pathname === OUTPUT_FRAME_PATH && revision) {
      if (!/^[0-9a-f]{64}$/.test(revision))
        return send(400, "text/plain", "Invalid catalog revision");
      const saved = await readFile(path.join(dir, revision, "manifest.json"));
      if (hash(saved) !== revision) throw Error("Unknown revision");
      const { imports, stylesheet } = JSON.parse(saved);
      const base = `${origin}/catalog/${revision}/`;
      const map = {
        imports: Object.fromEntries(Object.entries(imports).map(([id, file]) => [id, base + file])),
      };
      return send(
        200,
        "text/html; charset=utf-8",
        FRAME_HTML.replace(
          "</head>",
          `<link rel="stylesheet" href="${base}${stylesheet}"><script type="importmap">${JSON.stringify(map)}</script></head>`,
        ),
        {
          "Content-Security-Policy": FRAME_CSP.replace(
            "https: blob:",
            `https: blob: ${origin}`,
          ).replace(
            "style-src 'unsafe-inline' https:",
            `style-src 'unsafe-inline' https: ${origin}`,
          ),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      );
    }
    const response = await worker.fetch(new Request(url, { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch {
    send(404, "text/plain", "Catalog revision or asset unavailable");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Output ${origin}${OUTPUT_FRAME_PATH}\nCatalog ${origin}/catalog.json\nRevision ${pin}`,
  ),
);
