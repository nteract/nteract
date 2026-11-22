import { standardImports } from "./shared/widget-imports.mjs";
import { OUTPUT_STYLE_VARIABLES } from "@nteract/output-frame/context";

/** Public route serving the standalone zero-dependency Node dry-runner for Pages views. */
export const CHECK_VIEW_PATH = "/llms/check-view.mjs";

/**
 * Returns the standalone Node ESM script that agents download from
 * `/llms/check-view.mjs` to dry-run a Pages module or anywidget view locally
 * without a browser. Standard library names and host CSS variables are
 * interpolated from this build so the runner stays aligned with the host.
 */
const LOADER_HOOK_SOURCE = `
let cfg = { libraries: [], imports: {}, files: [], userUrls: [], allowNetwork: false };

export function initialize(data) {
  cfg = data;
}

function stubModule(specifier) {
  const lines = [
    "function makeProxy(label) {",
    "  const target = function (...args) { return makeProxy(label); };",
    "  return new Proxy(target, {",
    "    get(_, prop) {",
    '      if (prop === Symbol.toPrimitive) return () => "";',
    '      if (prop === "then") return undefined;',
    '      if (prop === "__esModule") return true;',
    '      return makeProxy(label + "." + String(prop));',
    "    },",
    "  });",
    "}",
    "const p = makeProxy(" + JSON.stringify(specifier) + ");",
    "export default p;",
  ];
  const namedByLib = {
    react: ["createElement", "Fragment", "useState", "useEffect", "useMemo", "useRef", "useCallback", "createContext", "useContext", "StrictMode", "memo", "forwardRef"],
    "react-dom": ["createPortal", "flushSync"],
    "react-dom/client": ["createRoot", "hydrateRoot"],
    "react/jsx-runtime": ["jsx", "jsxs", "Fragment"],
    "@observablehq/plot": ["plot", "dot", "line", "barY", "barX", "areaY", "areaX", "ruleY", "ruleX", "rectY", "rectX", "text", "tip", "cell", "axisX", "axisY", "frame", "groupX", "groupY", "binX", "binY", "windowY", "pointer", "pointerX", "pointerY"],
    d3: ["select", "selectAll", "scaleLinear", "scaleBand", "scaleTime", "scaleOrdinal", "scaleLog", "scaleSqrt", "extent", "min", "max", "mean", "median", "sum", "group", "rollup", "format", "timeFormat", "csvParse", "arc", "pie", "line", "area", "axisBottom", "axisLeft", "axisTop", "axisRight", "schemeCategory10", "schemeTableau10", "interpolateViridis"],
    "@nteract/sift/parquet": ["loadTableFile", "readParquetMetadata"],
  };
  for (const name of namedByLib[specifier] || [])
    lines.push("export const " + name + " = p." + name + ";");
  return lines.join("\\n");
}

export async function resolve(specifier, context, nextResolve) {
  const fromUser = !context.parentURL || cfg.userUrls.includes(context.parentURL);
  if (!fromUser) return nextResolve(specifier, context);
  if (cfg.userUrls.includes(specifier)) return nextResolve(specifier, context);
  if (Object.prototype.hasOwnProperty.call(cfg.imports, specifier)) {
    return { url: cfg.imports[specifier], shortCircuit: true };
  }
  if (specifier.startsWith("data/")) {
    const alias = specifier.slice(5);
    if (cfg.files.includes(alias)) {
      return { url: "pages-data:" + encodeURIComponent(alias), shortCircuit: true };
    }
    throw new Error(
      "Unbound data import " + JSON.stringify(specifier) + "; bind it with --data " + alias + "=<path>.",
    );
  }
  if (cfg.libraries.includes(specifier)) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return { url: "pages-lib:" + encodeURIComponent(specifier), shortCircuit: true };
    }
  }
  let https = false;
  try {
    https = new URL(specifier).protocol === "https:";
  } catch {}
  if (https) {
    if (cfg.allowNetwork) return nextResolve(specifier, context);
    return { url: "pages-ext:" + encodeURIComponent(specifier), shortCircuit: true };
  }
  throw new Error(
    "Import " + JSON.stringify(specifier) + " cannot load in a Pages view frame. " +
      "Allowed: " + cfg.libraries.join(", ") + ", bound --import names, data/<alias>, or https: URLs.",
  );
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("pages-data:")) {
    const alias = decodeURIComponent(url.slice("pages-data:".length));
    return {
      format: "module",
      shortCircuit: true,
      source: 'export default globalThis[Symbol.for("pages.checkView.data")].get(' + JSON.stringify(alias) + ");",
    };
  }
  if (url.startsWith("pages-lib:") || url.startsWith("pages-ext:")) {
    const spec = decodeURIComponent(url.slice(url.indexOf(":") + 1));
    return { format: "module", shortCircuit: true, source: stubModule(spec) };
  }
  if (cfg.userUrls.includes(url)) {
    const loaded = await nextLoad(url, { ...context, format: "module" });
    return { ...loaded, format: "module" };
  }
  return nextLoad(url, context);
}
`.trim();

export function checkViewScript() {
  const librariesJson = JSON.stringify([...standardImports]);
  const styleVarsJson = JSON.stringify([...OUTPUT_STYLE_VARIABLES]);
  const loaderSourceJson = JSON.stringify(LOADER_HOOK_SOURCE);
  return `#!/usr/bin/env node
// Standalone Pages view dry-runner (Node 20.6+, zero npm dependencies).
// Exercises import-map rules, fileObject/model/host contracts, mount,
// animation frames, theme switching, and AbortSignal cleanup without a browser.
//
// Usage:
//   node check-view.mjs <entry.js> [options]
//     --data <alias>=<path>    Bind a local file as model.get(alias) and "data/<alias>" (repeatable)
//     --import <name>=<path>   Bind a local JS file as bare import "<name>" (repeatable)
//     --anywidget              Check an anywidget default AFM export (buffers via --data)
//     --state <json>           Initial anywidget model state JSON object
//     --theme <light|dark>     Starting theme (default: light; switches to opposite during check)
//     --frames <n>             Animation frames to step after mount (default: 1)
//     --timeout <ms>           Timeout for mount and cleanup in ms (default: 5000)
//     --allow-network          Allow https: imports and fetch (default: stubbed offline)
//     --json                   Print machine-readable JSON report

import { readFileSync, realpathSync, statSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STANDARD_LIBRARIES = ${librariesJson};
const OUTPUT_STYLE_VARIABLES = ${styleVarsJson};
const DATA_SYMBOL = Symbol.for("pages.checkView.data");
const HELP = \`Usage: node check-view.mjs <entry.js> [options]

Options:
  --data <alias>=<path>    Bind a local file as model.get(alias) and "data/<alias>"
  --import <name>=<path>   Bind a local JS file as bare import "<name>"
  --anywidget              Validate an anywidget default AFM export
  --state <json>           Initial model state JSON (with --anywidget)
  --theme <light|dark>     Initial theme (default: light)
  --frames <n>             requestAnimationFrame steps to tick (default: 1)
  --timeout <ms>           Timeout per lifecycle phase (default: 5000)
  --allow-network          Allow https: imports and fetch instead of stubbing
  --json                   Emit JSON report
  -h, --help               Show this help
\`;

function parseArgs(argv) {
  const opts = {
    entry: null,
    data: new Map(),
    imports: new Map(),
    anywidget: false,
    state: {},
    theme: "light",
    frames: 1,
    timeout: 5000,
    allowNetwork: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === "--anywidget") {
      opts.anywidget = true;
    } else if (arg === "--allow-network") {
      opts.allowNetwork = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--data" || arg === "--import") {
      const pair = argv[++i];
      const eq = pair ? pair.indexOf("=") : -1;
      if (!pair || eq <= 0 || eq === pair.length - 1)
        throw new Error(\`\${arg} expects <name>=<path>\`);
      const name = pair.slice(0, eq);
      const target = path.resolve(pair.slice(eq + 1));
      if (arg === "--data") opts.data.set(name, target);
      else opts.imports.set(name, target);
    } else if (arg === "--state") {
      const raw = argv[++i];
      if (!raw) throw new Error("--state expects a JSON object");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("--state must be a JSON object");
      opts.state = parsed;
    } else if (arg === "--theme") {
      const val = argv[++i];
      if (val !== "light" && val !== "dark") throw new Error("--theme must be light or dark");
      opts.theme = val;
    } else if (arg === "--frames") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 120)
        throw new Error("--frames must be an integer between 0 and 120");
      opts.frames = n;
    } else if (arg === "--timeout") {
      const ms = Number(argv[++i]);
      if (!Number.isFinite(ms) || ms < 50 || ms > 120000)
        throw new Error("--timeout must be between 50 and 120000 ms");
      opts.timeout = ms;
    } else if (arg.startsWith("-")) {
      throw new Error(\`Unknown option: \${arg}\`);
    } else if (!opts.entry) {
      opts.entry = path.resolve(arg);
    } else {
      throw new Error(\`Unexpected argument: \${arg}\`);
    }
  }
  if (!opts.entry) throw new Error("Missing entry JavaScript file. Pass --help for usage.");
  return opts;
}

// --- Static pre-check (imports + CSP-blocked eval/new Function) ---

function stripCommentsAndStrings(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && code[i] !== "\\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        if (code[i] === "\\n") out += "\\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "\`") {
      const quote = ch;
      out += quote;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === "\\\\") {
          i += 2;
          continue;
        }
        if (code[i] === "\\n") out += "\\n";
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripCommentsOnly(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && code[i] !== "\\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        if (code[i] === "\\n") out += "\\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "\`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === "\\\\") {
          out += code[i] + (code[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += code[i];
        i++;
      }
      if (i < n) out += code[i++];
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function isHttps(specifier) {
  try {
    return new URL(specifier).protocol === "https:";
  } catch {
    return false;
  }
}

function staticCheckModule(label, filePath, allowedSet) {
  const code = readFileSync(filePath, "utf8");
  const errors = [];
  const warnings = [];
  const noComments = stripCommentsOnly(code);
  const noStrings = stripCommentsAndStrings(code);

  // Check static import / re-export specifiers
  const staticRe = /(?:^|[;}\\n])\\s*(?:import|export)\\s+(?:[^"'\\n;]*?\\s+from\\s+)?(["'])([^"'\\n]+)\\1/gm;
  for (const m of noComments.matchAll(staticRe)) {
    const spec = m[2];
    if (!isHttps(spec) && !allowedSet.has(spec)) {
      errors.push(
        \`Unresolved static import \${JSON.stringify(spec)} in \${label}. Allowed: \${[...allowedSet].join(", ")}, or an https: URL.\`,
      );
    }
  }
  // Check dynamic string-literal import()
  const dynRe = /\\bimport\\s*\\(\\s*(["'])([^"'\\n]+)\\1\\s*\\)/g;
  for (const m of noComments.matchAll(dynRe)) {
    const spec = m[2];
    if (!isHttps(spec) && !allowedSet.has(spec)) {
      warnings.push(
        \`Unresolved dynamic import(\${JSON.stringify(spec)}) in \${label} will fail in the Pages frame.\`,
      );
    }
  }
  if (/\\beval\\s*\\(/.test(noStrings) || /\\bnew\\s+Function\\s*\\(/.test(noStrings)) {
    errors.push(\`CSP violation in \${label}: eval() and new Function() throw in the Pages frame.\`);
  }
  return { errors, warnings };
}

// --- Pages FileAttachment / fileObject implementation ---

function inferMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".parquet": "application/vnd.apache.parquet",
      ".csv": "text/csv",
      ".json": "application/json",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".wav": "audio/wav",
    }[ext] ?? "application/octet-stream"
  );
}

function clampOffset(value, fallback, size) {
  if (value === undefined) return fallback;
  const offset = Math.trunc(Number(value)) || 0;
  return offset < 0 ? Math.max(size + offset, 0) : Math.min(offset, size);
}

function parseCsvRows(text) {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\\r" || ch === "\\n") {
      if (ch === "\\r" && clean[i + 1] === "\\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) {
    const empty = [];
    empty.columns = [];
    return Object.freeze(empty);
  }
  const columns = rows[0];
  const coerce = (raw) => {
    if (raw === "") return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?$/.test(raw)) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return raw;
  };
  const out = rows.slice(1).map((vals) => {
    const obj = {};
    for (let c = 0; c < columns.length; c++) obj[columns[c]] = coerce(vals[c] ?? "");
    return obj;
  });
  out.columns = columns;
  return out;
}

function createFileObject(alias, filePath, signal) {
  const raw = new Uint8Array(readFileSync(filePath));
  const size = raw.byteLength;
  const mimeType = inferMimeType(filePath);
  const checkLive = () => {
    if (signal.aborted) throw signal.reason ?? new Error("File object aborted.");
  };
  let textPromise;
  let jsonPromise;
  let csvPromise;
  let parquetPromise;
  const decodeText = () => {
    checkLive();
    textPromise ??= Promise.resolve(new TextDecoder().decode(raw));
    return textPromise;
  };
  return Object.freeze({
    name: alias,
    mimeType,
    size,
    byteLength: size,
    async read(offset, length, reqSignal) {
      checkLive();
      if (reqSignal?.aborted) throw reqSignal.reason ?? new Error("Read aborted.");
      const from = clampOffset(offset, 0, size);
      const end = clampOffset(from + Math.max(0, Number(length) || 0), size, size);
      return raw.slice(from, end);
    },
    async arrayBuffer() {
      checkLive();
      return raw.slice().buffer;
    },
    text: decodeText,
    json() {
      checkLive();
      jsonPromise ??= decodeText().then((s) => JSON.parse(s));
      return jsonPromise;
    },
    csv(...options) {
      checkLive();
      if (options.length > 1)
        return Promise.reject(new Error("csv() takes one options object; call it with no options or { typed: true }."));
      const [given] = options;
      if (given !== undefined) {
        if (!given || typeof given !== "object" || Array.isArray(given))
          return Promise.reject(new Error("csv() takes an options object; call it with no options or { typed: true }."));
        for (const key of Object.keys(given)) {
          if (key !== "typed")
            return Promise.reject(new Error(\`csv() has no \${key.slice(0, 40)} option; call it with no options or { typed: true }.\`));
        }
        if ("typed" in given && given.typed !== true)
          return Promise.reject(new Error("csv() always types its values, so its typed option must be true."));
      }
      csvPromise ??= decodeText().then(parseCsvRows);
      return csvPromise;
    },
    parquet(...options) {
      checkLive();
      if (options.length)
        return Promise.reject(new Error("parquet() takes no options yet; call it with none."));
      parquetPromise ??= Promise.resolve().then(() => {
        const magic = (off) => new TextDecoder().decode(raw.subarray(off, off + 4));
        if (size < 8 || magic(0) !== "PAR1" || magic(size - 4) !== "PAR1")
          throw new Error(\`\${alias} is not a valid Parquet file (missing PAR1 header/footer).\`);
        // Minimal Arrow-like table stub when Parquet binary is valid offline
        return Object.freeze({
          numRows: 0,
          schema: { fields: [] },
          getChild: () => ({ length: 0, toArray: () => [] }),
          toArray: () => [],
        });
      });
      return parquetPromise;
    },
    slice(start, end) {
      const from = clampOffset(start, 0, size);
      const to = clampOffset(end, size, size);
      const len = Math.max(to - from, 0);
      const bytes = raw.subarray(from, from + len);
      return Object.freeze({
        size: len,
        async arrayBuffer() {
          checkLive();
          return bytes.slice().buffer;
        },
        async text() {
          checkLive();
          return new TextDecoder().decode(bytes);
        },
      });
    },
  });
}

// --- Pages model and host context ---

function createLocalModel(initial, signal) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  const model = {
    get: (key) => values.get(key),
    set(key, value) {
      if (Object.is(values.get(key), value) && values.has(key)) return;
      values.set(key, value);
      for (const fn of [...(listeners.get(\`change:\${key}\`) ?? [])]) {
        if (!signal.aborted) fn();
      }
    },
    on(event, fn) {
      if (signal.aborted) return;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      for (const key of event == null ? [...listeners.keys()] : [event]) {
        if (fn == null) listeners.delete(key);
        else listeners.get(key)?.delete(fn);
      }
    },
    save_changes() {},
    send() {
      throw new Error("This anywidget host has no backend for custom messages.");
    },
  };
  signal.addEventListener("abort", () => listeners.clear(), { once: true });
  return model;
}

function makeThemeContext(theme) {
  const dark = theme === "dark";
  const defaults = {
    "--background": dark ? "oklch(0.145 0 0)" : "oklch(1 0 0)",
    "--foreground": dark ? "oklch(0.985 0 0)" : "oklch(0.145 0 0)",
    "--card": dark ? "oklch(0.205 0 0)" : "oklch(0.985 0 0)",
    "--card-foreground": dark ? "oklch(0.985 0 0)" : "oklch(0.145 0 0)",
    "--popover": dark ? "oklch(0.205 0 0)" : "oklch(1 0 0)",
    "--popover-foreground": dark ? "oklch(0.985 0 0)" : "oklch(0.145 0 0)",
    "--primary": dark ? "oklch(0.72 0.16 250)" : "oklch(0.52 0.18 250)",
    "--primary-foreground": "oklch(0.985 0 0)",
    "--secondary": dark ? "oklch(0.269 0 0)" : "oklch(0.96 0 0)",
    "--secondary-foreground": dark ? "oklch(0.985 0 0)" : "oklch(0.205 0 0)",
    "--muted": dark ? "oklch(0.269 0 0)" : "oklch(0.955 0 0)",
    "--muted-foreground": dark ? "oklch(0.708 0 0)" : "oklch(0.556 0 0)",
    "--accent": dark ? "oklch(0.269 0 0)" : "oklch(0.96 0 0)",
    "--accent-foreground": dark ? "oklch(0.985 0 0)" : "oklch(0.205 0 0)",
    "--destructive": "oklch(0.577 0.245 27.325)",
    "--destructive-foreground": "oklch(0.985 0 0)",
    "--border": dark ? "oklch(0.32 0 0)" : "oklch(0.89 0 0)",
    "--input": dark ? "oklch(0.32 0 0)" : "oklch(0.89 0 0)",
    "--ring": dark ? "oklch(0.6 0.15 250)" : "oklch(0.52 0.18 250)",
    "--radius": "0.5rem",
    "--output-ui-font": "system-ui, -apple-system, sans-serif",
    "--output-mono-font": "ui-monospace, SFMono-Regular, monospace",
    "--output-document-font": "Georgia, serif",
  };
  const variables = Object.fromEntries(
    OUTPUT_STYLE_VARIABLES.map((name) => [name, defaults[name] ?? "oklch(0.5 0 0)"]),
  );
  return Object.freeze({
    theme,
    styles: Object.freeze({ variables: Object.freeze(variables) }),
  });
}

// --- Lightweight DOM + Canvas2D + CSS selector shim (zero dependencies) ---

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

function camelToDataAttr(prop) {
  return "data-" + prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function makeStyleBag() {
  const props = new Map();
  return new Proxy(
    {
      setProperty(k, v) { props.set(String(k), String(v)); },
      removeProperty(k) { const prev = props.get(String(k)) ?? ""; props.delete(String(k)); return prev; },
      getPropertyValue(k) { return props.get(String(k)) ?? ""; },
      get cssText() { return [...props.entries()].map(([k, v]) => \`\${k}: \${v};\`).join(" "); },
      set cssText(val) {
        props.clear();
        for (const part of String(val).split(";")) {
          const idx = part.indexOf(":");
          if (idx > 0) props.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
        }
      },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return props.get(String(prop)) ?? "";
      },
      set(target, prop, value) {
        if (prop in target) target[prop] = value;
        else props.set(String(prop), String(value));
        return true;
      },
    },
  );
}

function makeCanvas2D(canvas) {
  return {
    canvas,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    font: "12px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    shadowBlur: 0,
    shadowColor: "rgba(0,0,0,0)",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    createImageData(w, h) {
      if (typeof w === "object" && w) { h = w.height; w = w.width; }
      return new globalThis.ImageData(Math.max(1, Math.trunc(w)), Math.max(1, Math.trunc(h)));
    },
    getImageData(x, y, w, h) {
      return new globalThis.ImageData(Math.max(1, Math.trunc(w)), Math.max(1, Math.trunc(h)));
    },
    putImageData() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    drawImage() {},
    save() {},
    restore() {},
    scale() {},
    rotate() {},
    translate() {},
    transform() {},
    setTransform() {},
    resetTransform() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    quadraticCurveTo() {},
    arc() {},
    arcTo() {},
    ellipse() {},
    rect() {},
    roundRect() {},
    fill() {},
    stroke() {},
    clip() {},
    fillText() {},
    strokeText() {},
    measureText(str) { return { width: String(str ?? "").length * 7 }; },
    setLineDash() {},
    getLineDash() { return []; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return {}; },
  };
}

function matchesSimple(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  let rest = sel.trim();
  if (!rest || rest === "*") return true;
  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length) {
    if (rest[0] === "#") {
      const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === ".") {
      const m = rest.match(/^\\.([a-zA-Z0-9_-]+)/);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "[") {
      const m = rest.match(/^\\[\\s*([a-zA-Z0-9_:-]+)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\]\\s]+)))?\\s*\\]/);
      if (!m) return false;
      const attrVal = el.getAttribute(m[1]);
      const expected = m[2] ?? m[3] ?? m[4];
      if (attrVal === null) return false;
      if (expected !== undefined && attrVal !== expected) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === ":") {
      // Ignore pseudo-classes like :first-child / :checked for static lookup
      const m = rest.match(/^:[a-zA-Z0-9_-]+(?:\\([^)]*\\))?/);
      if (!m) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchesSelector(el, selector) {
  for (const branch of String(selector).split(",")) {
    const tokens = branch.trim().split(/\\s*(>)\\s*|\\s+/).filter(Boolean);
    if (!tokens.length) continue;
    let idx = tokens.length - 1;
    if (!matchesSimple(el, tokens[idx])) continue;
    idx--;
    let cur = el.parentNode;
    let ok = true;
    while (idx >= 0) {
      if (tokens[idx] === ">") {
        idx--;
        if (!cur || !matchesSimple(cur, tokens[idx])) { ok = false; break; }
        cur = cur.parentNode;
        idx--;
      } else {
        while (cur && !matchesSimple(cur, tokens[idx])) cur = cur.parentNode;
        if (!cur) { ok = false; break; }
        cur = cur.parentNode;
        idx--;
      }
    }
    if (ok) return true;
  }
  return false;
}

class ShimNode {
  constructor(nodeType, ownerDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() {
    let cur = this;
    while (cur) {
      if (cur === this.ownerDocument || cur === this.ownerDocument?.documentElement) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  appendChild(child) {
    if (!child) return child;
    if (child.nodeType === 11) {
      for (const n of [...child.childNodes]) this.appendChild(n);
      return child;
    }
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    const idx = this.childNodes.indexOf(ref);
    if (idx === -1) return this.appendChild(node);
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.childNodes.splice(idx, 0, node);
    return node;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) { this.childNodes.splice(idx, 1); child.parentNode = null; }
    return child;
  }
  append(...nodes) {
    for (const n of nodes) {
      this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n);
    }
  }
  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) {
      this.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, first);
    }
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  addEventListener(type, fn, opts) {
    if (typeof fn !== "function") return;
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    const sig = typeof opts === "object" ? opts?.signal : null;
    if (sig) sig.addEventListener("abort", () => this.removeEventListener(type, fn), { once: true });
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  dispatchEvent(ev) {
    for (const fn of [...(this._listeners.get(ev.type) ?? [])]) fn.call(this, ev);
    return true;
  }
}

class ShimText extends ShimNode {
  constructor(text, ownerDocument) {
    super(3, ownerDocument);
    this.data = String(text ?? "");
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v ?? ""); }
}

class ShimElement extends ShimNode {
  constructor(tag, ownerDocument) {
    super(1, ownerDocument);
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this._attrs = new Map();
    this._classes = new Set();
    this._ctx2d = null;
    this.style = makeStyleBag();
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.width = this.tagName === "CANVAS" ? 300 : 0;
    this.height = this.tagName === "CANVAS" ? 150 : 0;
    this.tabIndex = -1;
    this.classList = {
      add: (...cs) => { for (const c of cs) if (c) this._classes.add(c); this._syncClass(); },
      remove: (...cs) => { for (const c of cs) this._classes.delete(c); this._syncClass(); },
      contains: (c) => this._classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this._classes.has(c) : Boolean(force);
        if (on) this._classes.add(c); else this._classes.delete(c);
        this._syncClass();
        return on;
      },
    };
    this.dataset = new Proxy({}, {
      get: (_, prop) => {
        if (typeof prop !== "string") return undefined;
        const v = this._attrs.get(camelToDataAttr(prop));
        return v === undefined ? undefined : v;
      },
      set: (_, prop, value) => {
        if (typeof prop === "string") this._attrs.set(camelToDataAttr(prop), String(value));
        return true;
      },
      deleteProperty: (_, prop) => {
        if (typeof prop === "string") this._attrs.delete(camelToDataAttr(prop));
        return true;
      },
    });
  }
  _syncClass() {
    const val = [...this._classes].join(" ");
    if (val) this._attrs.set("class", val); else this._attrs.delete("class");
  }
  get id() { return this._attrs.get("id") ?? ""; }
  set id(v) { this._attrs.set("id", String(v)); }
  get className() { return [...this._classes].join(" "); }
  set className(v) {
    this._classes = new Set(String(v ?? "").split(/\\s+/).filter(Boolean));
    this._syncClass();
  }
  setAttribute(name, value) {
    const k = String(name).toLowerCase();
    const v = String(value);
    this._attrs.set(k, v);
    if (k === "class") this._classes = new Set(v.split(/\\s+/).filter(Boolean));
    else if (k === "value") this.value = v;
    else if (k === "width") this.width = Number(v) || 0;
    else if (k === "height") this.height = Number(v) || 0;
    else if (k === "style") this.style.cssText = v;
  }
  getAttribute(name) {
    const v = this._attrs.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }
  hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }
  removeAttribute(name) {
    const k = String(name).toLowerCase();
    this._attrs.delete(k);
    if (k === "class") this._classes.clear();
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v) {
    this.replaceChildren(v == null || v === "" ? [] : this.ownerDocument.createTextNode(String(v)));
    if (v == null || v === "") this.childNodes = [];
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(html) {
    for (const c of [...this.childNodes]) c.parentNode = null;
    this.childNodes = [];
    parseHtmlInto(String(html ?? ""), this, this.ownerDocument);
  }
  getContext(type) {
    if (type === "2d") {
      this._ctx2d ??= makeCanvas2D(this);
      return this._ctx2d;
    }
    return null;
  }
  getBoundingClientRect() {
    const w = this.width || 540;
    const h = this.height || 350;
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  }
  get clientWidth() { return this.width || 540; }
  get clientHeight() { return this.height || 350; }
  focus() {}
  blur() {}
  click() { this.dispatchEvent({ type: "click", target: this, preventDefault() {}, stopPropagation() {} }); }
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (matchesSelector(child, selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getElementById(id) { return this.querySelector(\`#\${id}\`); }
  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matchesSelector(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}

function parseHtmlInto(html, root, doc) {
  const stack = [root];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const cur = stack[stack.length - 1];
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      if (i < n) cur.appendChild(doc.createTextNode(html.slice(i)));
      break;
    }
    if (lt > i) cur.appendChild(doc.createTextNode(html.slice(i, lt)));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "/") {
      const gt = html.indexOf(">", lt + 2);
      if (gt === -1) break;
      const closeTag = html.slice(lt + 2, gt).trim().toUpperCase();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tagName === closeTag) { stack.length = s; break; }
      }
      i = gt + 1;
      continue;
    }
    const tagMatch = html.slice(lt + 1).match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!tagMatch) {
      cur.appendChild(doc.createTextNode("<"));
      i = lt + 1;
      continue;
    }
    const tagName = tagMatch[1].toLowerCase();
    let p = lt + 1 + tagMatch[1].length;
    const el = doc.createElement(tagName);
    let selfClosing = false;
    while (p < n) {
      while (p < n && /\\s/.test(html[p])) p++;
      if (p >= n) break;
      if (html[p] === ">") { p++; break; }
      if (html[p] === "/" && html[p + 1] === ">") { selfClosing = true; p += 2; break; }
      const attrMatch = html.slice(p).match(/^([a-zA-Z0-9_:@.-]+)/);
      if (!attrMatch) { p++; continue; }
      const attrName = attrMatch[1];
      p += attrName.length;
      while (p < n && /\\s/.test(html[p])) p++;
      let attrVal = "";
      if (html[p] === "=") {
        p++;
        while (p < n && /\\s/.test(html[p])) p++;
        if (html[p] === '"' || html[p] === "'") {
          const q = html[p++];
          const endQ = html.indexOf(q, p);
          attrVal = endQ === -1 ? html.slice(p) : html.slice(p, endQ);
          p = endQ === -1 ? n : endQ + 1;
        } else {
          const valMatch = html.slice(p).match(/^[^\\s>]+/);
          attrVal = valMatch ? valMatch[0] : "";
          p += attrVal.length;
        }
      }
      el.setAttribute(attrName, attrVal);
    }
    cur.appendChild(el);
    if (tagName === "style" || tagName === "script") {
      const closeRe = new RegExp(\`</\${tagName}\\\\s*>\`, "i");
      const m = closeRe.exec(html.slice(p));
      if (m) {
        el.appendChild(doc.createTextNode(html.slice(p, p + m.index)));
        p += m.index + m[0].length;
      } else {
        el.appendChild(doc.createTextNode(html.slice(p)));
        p = n;
      }
    } else if (!selfClosing && !VOID_TAGS.has(tagName)) {
      stack.push(el);
    }
    i = p;
  }
}

function installBrowserGlobals(context, allowNetwork) {
  const doc = {
    nodeType: 9,
    createElement(tag) { return new ShimElement(tag, doc); },
    createElementNS(_, tag) { return new ShimElement(tag, doc); },
    createTextNode(t) { return new ShimText(t, doc); },
    createDocumentFragment() { return new ShimNode(11, doc); },
    querySelector(s) { return doc.body.querySelector(s); },
    querySelectorAll(s) { return doc.body.querySelectorAll(s); },
    getElementById(id) { return doc.body.getElementById(id); },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.documentElement = doc.createElement("html");
  doc.head = doc.createElement("head");
  doc.body = doc.createElement("body");
  doc.documentElement.append(doc.head, doc.body);

  let rafSeq = 0;
  const rafQueue = new Map();
  const activeIntervals = new Set();
  let syntheticNow = performance.now();

  const winListeners = new Map();
  const win = {
    document: doc,
    devicePixelRatio: 1,
    innerWidth: 720,
    innerHeight: 600,
    location: { href: "about:srcdoc", origin: "null", protocol: "about:" },
    getComputedStyle(el) {
      return {
        getPropertyValue(name) {
          return el?.style?.getPropertyValue?.(name) || context.styles.variables[name] || "";
        },
      };
    },
    addEventListener(type, fn, opts) {
      if (typeof fn !== "function") return;
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
      const sig = typeof opts === "object" ? opts?.signal : null;
      if (sig) sig.addEventListener("abort", () => win.removeEventListener(type, fn), { once: true });
    },
    removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
    requestAnimationFrame(cb) {
      const id = ++rafSeq;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) { rafQueue.delete(id); },
  };
  doc.defaultView = win;

  globalThis.window = win;
  globalThis.self = win;
  globalThis.document = doc;
  globalThis.HTMLElement = ShimElement;
  globalThis.Element = ShimElement;
  globalThis.Node = ShimNode;
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.getComputedStyle = win.getComputedStyle;
  globalThis.ImageData = class ImageData {
    constructor(dataOrWidth, widthOrHeight, maybeHeight) {
      if (dataOrWidth instanceof Uint8ClampedArray) {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = maybeHeight ?? Math.floor(dataOrWidth.length / (4 * widthOrHeight));
      } else {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
    }
  };
  globalThis.Image = class Image {
    constructor() { this.width = 0; this.height = 0; this._src = ""; }
    set src(v) { this._src = String(v); }
    get src() { return this._src; }
  };
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (fn, ms, ...args) => {
    const h = origSetInterval(fn, ms, ...args);
    h.unref?.();
    activeIntervals.add(h);
    return h;
  };
  globalThis.clearInterval = (h) => { activeIntervals.delete(h); origClearInterval(h); };
  globalThis.setTimeout = (fn, ms, ...args) => {
    const h = origSetTimeout(fn, ms, ...args);
    h.unref?.();
    return h;
  };

  // Enforce Pages frame CSP on fetch()
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input?.url ?? String(input);
    if (/^(?:data|blob):/i.test(rawUrl))
      throw new TypeError(\`Pages CSP blocks fetch() of \${rawUrl.slice(0, 16)} URLs.\`);
    if (!allowNetwork)
      throw new Error(\`Network fetch(\${JSON.stringify(rawUrl)}) blocked in offline dry-run (pass --allow-network to allow).\`);
    return realFetch(input, init);
  };

  return {
    doc,
    win,
    stepFrame() {
      syntheticNow = Math.max(syntheticNow, performance.now()) + 16.67;
      const pending = [...rafQueue.entries()];
      rafQueue.clear();
      for (const [, cb] of pending) cb(syntheticNow);
      return pending.length;
    },
    counts() {
      return {
        pendingRafs: rafQueue.size,
        activeIntervals: activeIntervals.size,
        windowListeners: [...winListeners.values()].reduce((n, s) => n + s.size, 0),
      };
    },
  };
}

// --- Node module loader hook mirroring Pages import-map resolution ---

const LOADER_SOURCE = ${loaderSourceJson};

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(\`\${label} timed out after \${ms}ms.\`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = {
    ok: false,
    entry: opts.entry,
    mode: opts.anywidget ? "anywidget" : "module",
    framesStepped: 0,
    themeSwitched: false,
    cleanedUp: false,
    warnings: [],
    errors: [],
  };

  // Verify entry, import, and data files exist
  for (const [label, filePath] of [
    ["entry", opts.entry],
    ...[...opts.imports.entries()].map(([k, v]) => [\`import "\${k}"\`, v]),
    ...[...opts.data.entries()].map(([k, v]) => [\`data "\${k}"\`, v]),
  ]) {
    try {
      if (!statSync(filePath).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(\`Cannot read \${label} at \${filePath}\`);
    }
  }

  // 1. Static import & CSP pre-check
  const allowed = new Set([
    ...STANDARD_LIBRARIES,
    ...opts.imports.keys(),
    ...[...opts.data.keys()].map((a) => \`data/\${a}\`),
  ]);
  for (const [label, filePath] of [["entry", opts.entry], ...opts.imports.entries()]) {
    const res = staticCheckModule(label, filePath, allowed);
    report.errors.push(...res.errors);
    report.warnings.push(...res.warnings);
  }
  if (report.errors.length) {
    emit(report, opts.json);
    process.exit(1);
  }

  // 2. Register Pages import-map loader hook (canonicalize symlinks like /var -> /private/var)
  const entryUrl = pathToFileURL(realpathSync(opts.entry)).href;
  const importUrls = Object.fromEntries(
    [...opts.imports.entries()].map(([k, v]) => [k, pathToFileURL(realpathSync(v)).href]),
  );
  const userUrls = [entryUrl, ...Object.values(importUrls)];
  register("data:text/javascript," + encodeURIComponent(LOADER_SOURCE), {
    data: {
      libraries: STANDARD_LIBRARIES,
      imports: importUrls,
      files: [...opts.data.keys()],
      userUrls,
      allowNetwork: opts.allowNetwork,
    },
  });

  // 3. Install Pages runtime globals, data files, model, and host
  const ac = new AbortController();
  const { signal } = ac;
  let currentContext = makeThemeContext(opts.theme);
  const contextListeners = new Set();
  const host = {
    getContext: () => currentContext,
    onContextChange(listener) {
      if (typeof listener !== "function") return () => {};
      contextListeners.add(listener);
      return () => contextListeners.delete(listener);
    },
  };
  const env = installBrowserGlobals(currentContext, opts.allowNetwork);
  const dataRegistry = new Map();
  const initialState = { ...opts.state };
  for (const [alias, filePath] of opts.data.entries()) {
    if (opts.anywidget) {
      const bytes = new Uint8Array(readFileSync(filePath));
      initialState[alias] = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else {
      const fileObj = createFileObject(alias, filePath, signal);
      dataRegistry.set(alias, fileObj);
      initialState[alias] = fileObj;
    }
  }
  globalThis[DATA_SYMBOL] = dataRegistry;
  const model = createLocalModel(initialState, signal);
  const el = env.doc.createElement("div");
  env.doc.body.appendChild(el);

  // 4. Import entry and validate export contract
  const exported = await withTimeout(import(entryUrl), opts.timeout, "Module import");
  const widget =
    !opts.anywidget && typeof exported.render === "function"
      ? { render: exported.render }
      : typeof exported.default === "function"
        ? await withTimeout(exported.default(), opts.timeout, "Default factory")
        : exported.default;
  if (
    !widget ||
    (typeof widget.initialize !== "function" && typeof widget.render !== "function")
  ) {
    throw new Error(
      opts.anywidget
        ? "The AFM default export needs initialize or render."
        : "Export render({ model, el, signal, host }) or a default AFM object.",
    );
  }

  // 5. Run initialize + render
  const cleanups = [];
  if (typeof widget.initialize === "function") {
    const initCleanup = await withTimeout(
      Promise.resolve(widget.initialize({ model, signal })),
      opts.timeout,
      "initialize()",
    );
    if (typeof initCleanup === "function") cleanups.push(initCleanup);
  }
  if (typeof widget.render === "function") {
    const renderCleanup = await withTimeout(
      Promise.resolve(widget.render({ model, el, signal, host })),
      opts.timeout,
      "render()",
    );
    if (typeof renderCleanup === "function") cleanups.push(renderCleanup);
  }

  // 6. Step animation frames
  for (let f = 0; f < opts.frames; f++) {
    env.stepFrame();
    report.framesStepped++;
  }
  if (el.childNodes.length === 0 && !el.textContent) {
    report.warnings.push("Mount container (el) is empty after render().");
  }

  // 7. Exercise light <-> dark theme switch
  currentContext = makeThemeContext(opts.theme === "light" ? "dark" : "light");
  for (const listener of [...contextListeners]) listener(currentContext);
  report.themeSwitched = true;

  // 8. Abort signal and run cleanups
  ac.abort();
  for (const fn of cleanups) {
    await withTimeout(Promise.resolve(fn()), opts.timeout, "cleanup()");
  }
  report.cleanedUp = true;

  const after = env.counts();
  if (after.pendingRafs > 0)
    report.warnings.push(\`\${after.pendingRafs} requestAnimationFrame callback(s) left pending after abort/cleanup.\`);
  if (after.activeIntervals > 0)
    report.warnings.push(\`\${after.activeIntervals} setInterval timer(s) left active after abort/cleanup.\`);
  if (after.windowListeners > 0)
    report.warnings.push(\`\${after.windowListeners} window event listener(s) left attached after abort/cleanup.\`);

  report.ok = true;
  emit(report, opts.json);
}

function emit(report, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
    return;
  }
  if (report.ok) {
    console.log(
      \`OK \${path.basename(report.entry)} (\${report.mode}): mounted, \${report.framesStepped} frame(s), theme switched, cleaned up.\`,
    );
  } else {
    for (const err of report.errors) console.error(\`ERROR: \${err}\`);
  }
  for (const warn of report.warnings) console.warn(\`WARN: \${warn}\`);
}

main().catch((error) => {
  const asJson = process.argv.includes("--json");
  const msg = error?.stack ?? String(error);
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: false, errors: [msg], warnings: [] }, null, 2) + "\\n");
  } else {
    console.error(\`FAIL: \${msg}\`);
  }
  process.exit(1);
});
`;
}
