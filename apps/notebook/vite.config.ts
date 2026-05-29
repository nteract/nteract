import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { visualizer } from "rollup-plugin-visualizer";
import { type Plugin, defineConfig } from "vite-plus";
import { browserDevRelayPlugin } from "./vite-plugin-browser-relay";
import { isolatedRendererPlugin } from "./vite-plugin-isolated-renderer";
import { rawLibPlugin } from "./vite-plugin-raw-lib";

/**
 * Redirect missing-trailing-slash URLs for our multi-entry sub-apps to the
 * canonical `/name/` form. Without this, Vite dev falls back to the SPA
 * fallback which serves `index.html` (the main notebook app) — that entry
 * wires up a Tauri transport and throws when loaded standalone in a browser.
 *
 * Production static hosts (Cloudflare Pages, nginx with `try_files`, etc.)
 * do this automatically; this middleware plugs the gap for `pnpm dev`.
 */
function subAppTrailingSlashRedirect(names: string[]): Plugin {
  return {
    name: "sub-app-trailing-slash-redirect",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        // Strip any query / hash before matching.
        const pathOnly = url.split(/[?#]/, 1)[0];
        for (const name of names) {
          if (pathOnly === `/${name}`) {
            res.statusCode = 301;
            const suffix = url.slice(pathOnly.length);
            res.setHeader("Location", `/${name}/${suffix}`);
            res.end();
            return;
          }
        }
        next();
      });
    },
  };
}

function prototypeRootRedirect(route: string | undefined): Plugin {
  return {
    name: "prototype-root-redirect",
    configureServer(server) {
      if (!route) return;
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const pathOnly = url.split(/[?#]/, 1)[0];
        if (pathOnly === "/" || pathOnly === "/index.html") {
          const suffix = url.slice(pathOnly.length);
          res.statusCode = 302;
          res.setHeader("Location", `${route}${suffix}`);
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(() => {
  const debugBundleSourceMapsEnabled = process.env.RUNT_NOTEBOOK_DEBUG_BUILD === "1";

  return {
    plugins: [
      react(),
      tailwindcss(),
      prototypeRootRedirect(process.env.RUNT_NOTEBOOK_PROTOTYPE_ROUTE),
      rawLibPlugin(path.resolve(__dirname, "../../node_modules")),
      isolatedRendererPlugin(),
      browserDevRelayPlugin({ repoRoot: path.resolve(__dirname, "../..") }),
      subAppTrailingSlashRedirect([
        "onboarding",
        "settings",
        "feedback",
        "diagnostics",
        "upgrade",
        "gallery",
        "prototypes/sidebar-toc",
      ]),
      visualizer({
        filename: "dist/stats.html",
        open: false,
        gzipSize: true,
        brotliSize: true,
      }),
    ],
    resolve: {
      alias: {
        "@/": path.resolve(__dirname, "../../src") + "/",
        "~/": path.resolve(__dirname, "./src") + "/",
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: debugBundleSourceMapsEnabled,
      chunkSizeWarningLimit: 10000,
      rolldownOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
          onboarding: path.resolve(__dirname, "onboarding/index.html"),
          upgrade: path.resolve(__dirname, "upgrade/index.html"),
          settings: path.resolve(__dirname, "settings/index.html"),
          feedback: path.resolve(__dirname, "feedback/index.html"),
          diagnostics: path.resolve(__dirname, "diagnostics/index.html"),
          gallery: path.resolve(__dirname, "gallery/index.html"),
        },
        output: {
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash].[ext]",
        },
      },
    },
    server: {
      port: parseInt(process.env.RUNTIMED_VITE_PORT || process.env.CONDUCTOR_PORT || "5174"),
      strictPort: true,
    },
    base: "/",
  };
});
