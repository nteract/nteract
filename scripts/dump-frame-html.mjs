import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? resolve(repoRoot, "crates/notebook/src/iframe_shell/frame.html");

const { generateFrameHtml } = await import(
  resolve(repoRoot, "src/components/isolated/frame-html.ts")
);

writeFileSync(out, generateFrameHtml());
process.stdout.write(out + "\n");
