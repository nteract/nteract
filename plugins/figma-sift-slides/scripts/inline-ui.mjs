import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const buildDir = resolve(pluginRoot, "dist/ui-build");
const htmlPath = resolve(buildDir, "index.html");
const outputPath = resolve(pluginRoot, "dist/ui.html");

let html = readFileSync(htmlPath, "utf8");

html = html.replace(
  /<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/g,
  (_match, src) => {
    const script = readFileSync(resolve(buildDir, src), "utf8");
    return `<script type="module">\n${script}\n</script>`;
  },
);

html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/g, (_match, href) => {
  const css = readFileSync(resolve(buildDir, href), "utf8");
  return `<style>\n${css}\n</style>`;
});

writeFileSync(outputPath, html);

if (existsSync(buildDir)) {
  rmSync(buildDir, { recursive: true, force: true });
}
