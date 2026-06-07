import { defineConfig, type Plugin } from "vite-plus";
import { configDefaults } from "vitest/config";
import path from "path";
import { rawLibPlugin } from "./apps/notebook/vite-plugin-raw-lib";

const ignoredDiagnosticWorkspaces = [".context/**", "**/.context/**"];

/** Stub virtual:renderer-plugin/* modules for tests (real builds use the Vite plugin). */
function rendererPluginStub(): Plugin {
  const prefix = "virtual:renderer-plugin/";
  return {
    name: "renderer-plugin-stub",
    resolveId(id) {
      if (id.startsWith(prefix)) return `\0${id}`;
    },
    load(id) {
      if (id.startsWith(`\0${prefix}`)) {
        return 'export const code = ""; export const css = "";';
      }
    },
  };
}

/** Stub virtual:isolated-renderer for tests (real builds use the Vite plugin). */
function isolatedRendererStub(): Plugin {
  const id = "virtual:isolated-renderer";
  const resolved = `\0${id}`;
  return {
    name: "isolated-renderer-stub",
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(source) {
      if (source === resolved) {
        return 'export const rendererCode = ""; export const rendererCss = "";';
      }
    },
  };
}

export default defineConfig({
  plugins: [
    rawLibPlugin(path.resolve(__dirname, "./node_modules")),
    rendererPluginStub(),
    isolatedRendererStub(),
  ],
  test: {
    environment: "jsdom",
    include: [
      "src/**/__tests__/**/*.test.{ts,tsx}",
      "apps/notebook/src/**/__tests__/**/*.test.{ts,tsx}",
      "apps/mcp-app/src/**/__tests__/**/*.test.{js,ts,tsx}",
      "packages/**/tests/**/*.test.{ts,tsx}",
      "plugins/nteract/pi/**/*.test.{ts,tsx}",
    ],
    exclude: [...configDefaults.exclude, ...ignoredDiagnosticWorkspaces],
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
  benchmark: {
    exclude: [...configDefaults.exclude, ...ignoredDiagnosticWorkspaces],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
