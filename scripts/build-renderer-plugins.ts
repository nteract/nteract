/**
 * Build pre-built renderer plugin artifacts into a single canonical dir.
 *
 * Output: `apps/notebook/src/renderer-plugins/` - core IIFE + CJS plugins.
 * Stable bundles (plotly, vega, leaflet, markdown, isolated-renderer) are
 * LFS-tracked; sift.{js,css} stay gitignored because they re-embed
 * sift-wasm's wasm-bindgen glue and must be rebuilt in lockstep.
 *
 * The notebook Vite app loads these CJS bundles directly. runtimed
 * `include_bytes!`-es them, and the blob server wraps `.js` responses with
 * the MCP App IIFE loader at serve time - no second on-disk copy.
 *
 * Run locally after a fresh clone, or when renderer source changes:
 *
 *   cargo xtask renderer-plugins
 *   cargo xtask renderer-plugins --only sift
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite-plus";
import {
  buildAllRendererPlugins,
  RENDERER_ROLLDOWN_CHECKS,
  RENDERER_PLUGINS,
} from "../src/build/renderer-plugin-builder.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const notebookPluginDir = path.join(repoRoot, "apps/notebook/src/renderer-plugins");
const coreTargetNames = new Set(["core", "isolated-renderer"]);

type RendererPluginSelection = {
  buildCore: boolean;
  plugins: typeof RENDERER_PLUGINS;
};

function printUsage() {
  console.log(`Usage: node --experimental-strip-types scripts/build-renderer-plugins.ts [--only <target>[,<target>...]]

Targets:
  isolated-renderer  Core isolated renderer IIFE and CSS
  core               Alias for isolated-renderer
  markdown           Markdown renderer plugin
  plotly             Plotly renderer plugin
  vega               Vega renderer plugin
  leaflet            Leaflet renderer plugin
  sift               Sift renderer plugin
`);
}

function splitTargetList(value: string): string[] {
  return value
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
}

function parseSelection(args: string[]): RendererPluginSelection {
  const onlyTargets: string[] = [];
  let sawOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--only") {
      sawOnly = true;
      const value = args[index + 1];
      if (!value) throw new Error("Missing renderer plugin target after --only");
      onlyTargets.push(...splitTargetList(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--only=")) {
      sawOnly = true;
      onlyTargets.push(...splitTargetList(arg.slice("--only=".length)));
      continue;
    }
    throw new Error(`Unknown renderer plugin build argument: ${arg}`);
  }

  if (onlyTargets.length === 0) {
    if (sawOnly) throw new Error("No renderer plugin targets specified");
    return { buildCore: true, plugins: RENDERER_PLUGINS };
  }

  const pluginNames = new Set(RENDERER_PLUGINS.map((plugin) => plugin.name));
  const unknownTargets = onlyTargets.filter(
    (target) => !coreTargetNames.has(target) && !pluginNames.has(target),
  );
  if (unknownTargets.length > 0) {
    throw new Error(`Unknown renderer plugin target(s): ${unknownTargets.join(", ")}`);
  }

  const targetSet = new Set(onlyTargets);
  return {
    buildCore: [...coreTargetNames].some((target) => targetSet.has(target)),
    plugins: RENDERER_PLUGINS.filter((plugin) => targetSet.has(plugin.name)),
  };
}

async function buildCoreIIFE(): Promise<{ code: string; css: string }> {
  const srcDir = path.join(repoRoot, "src");
  const nodeModules = path.join(repoRoot, "node_modules");

  const result = await build({
    configFile: false,
    mode: "production",
    plugins: [
      tailwindcss(),
      {
        name: "vega-raw-resolve",
        resolveId(source: string) {
          const mapping: Record<string, string> = {
            "vega-raw": path.join(nodeModules, "vega/build/vega.min.js"),
            "vega-lite-raw": path.join(nodeModules, "vega-lite/build/vega-lite.min.js"),
            "vega-embed-raw": path.join(nodeModules, "vega-embed/build/vega-embed.min.js"),
            "leaflet-js-raw": path.join(nodeModules, "leaflet/dist/leaflet.js"),
            "leaflet-css-raw": path.join(nodeModules, "leaflet/dist/leaflet.css"),
          };
          const filePath = mapping[source];
          if (filePath) return `${filePath}?raw`;
          return null;
        },
      },
    ],
    esbuild: { jsx: "automatic", jsxImportSource: "react", jsxDev: false },
    resolve: { alias: { "@/": `${srcDir}/` } },
    build: {
      write: false,
      lib: {
        entry: path.join(srcDir, "isolated-renderer/index.tsx"),
        name: "IsolatedRenderer",
        formats: ["iife"],
        fileName: () => "isolated-renderer.js",
      },
      rolldownOptions: {
        checks: RENDERER_ROLLDOWN_CHECKS,
        output: { assetFileNames: "isolated-renderer.[ext]" },
        external: [
          "@tauri-apps/api",
          "@tauri-apps/plugin-shell",
          "@tauri-apps/plugin-fs",
          /^@tauri-apps\/.*/,
        ],
        onwarn(warning, warn) {
          if (
            warning.code === "MODULE_LEVEL_DIRECTIVE" &&
            warning.message?.includes('"use client"')
          )
            return;
          warn(warning);
        },
      },
      minify: true,
      sourcemap: false,
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "warn",
  });

  let code = "";
  let css = "";
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if ("output" in output) {
      for (const chunk of output.output) {
        if (chunk.type === "chunk" && chunk.fileName.endsWith(".js")) {
          code = chunk.code;
        } else if (chunk.type === "asset" && chunk.fileName.endsWith(".css")) {
          css =
            typeof chunk.source === "string"
              ? chunk.source
              : new TextDecoder().decode(chunk.source);
        }
      }
    }
  }

  if (!code) throw new Error("Failed to build isolated renderer IIFE");
  return { code, css };
}

async function main() {
  fs.mkdirSync(notebookPluginDir, { recursive: true });
  const selection = parseSelection(process.argv.slice(2));

  // Build selected artifacts in parallel. `cargo xtask wasm` uses this to
  // refresh only sift after rebuilding sift-wasm, avoiding incidental churn in
  // the LFS-tracked stable renderer bundles.
  const [iife, plugins] = await Promise.all([
    selection.buildCore ? buildCoreIIFE() : Promise.resolve(null),
    selection.plugins.length > 0
      ? buildAllRendererPlugins(selection.plugins)
      : Promise.resolve([]),
  ]);

  if (iife) {
    fs.writeFileSync(path.join(notebookPluginDir, "isolated-renderer.js"), iife.code);
    fs.writeFileSync(path.join(notebookPluginDir, "isolated-renderer.css"), iife.css);
    console.log(
      `  isolated-renderer: ${(iife.code.length / 1024).toFixed(0)} kB JS, ${(iife.css.length / 1024).toFixed(0)} kB CSS`,
    );
  }

  for (const { name, code, css } of plugins) {
    fs.writeFileSync(path.join(notebookPluginDir, `${name}.js`), code);
    if (css) fs.writeFileSync(path.join(notebookPluginDir, `${name}.css`), css);

    const sizeParts = [`${(code.length / 1024).toFixed(0)} kB JS`];
    if (css) sizeParts.push(`${(css.length / 1024).toFixed(0)} kB CSS`);
    console.log(`  ${name}: ${sizeParts.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
