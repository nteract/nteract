// Test-only oracle from the requested base, not a second production validator.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const baseRevision =
  process.env.PAGES_VALIDATION_BASE || "02b8c81cfd7090294f6fc0aaf7dc4bf05df22f9d";
const root = new URL("../", import.meta.url);
const prefix = "docs/memos/authenticated-automerge-app-substrate/experiment/pages/";
// All transitive local validator dependencies must still be the base's source.
// Otherwise a data-URL import could silently compare two changed contracts.
const seen = new Set();
function verifyBase(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const url = new URL(file, root);
  const actual = readFileSync(url, "utf8");
  const expected = execFileSync("git", ["show", `${baseRevision}:${prefix}${file}`], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  });
  if (actual !== expected) throw Error(`Oracle dependency differs from ${baseRevision}: ${file}`);
  for (const match of actual.matchAll(/(?:from\s+|import\s*)["'](\.\.?\/[^"']+)["']/g)) {
    const dependency = new URL(match[1], url);
    verifyBase(fileURLToPath(dependency).slice(fileURLToPath(root).length));
  }
}
for (const file of [
  "model/pm-adapter.mjs",
  "model/marks.mjs",
  "model/node-registry.mjs",
  "model/richtext-format.mjs",
  "model/markdown-serializer.mjs",
  "shared/dataset-assets.mjs",
])
  verifyBase(file);
const source = execFileSync("git", ["show", `${baseRevision}:${prefix}model/richtext-spans.mjs`], {
  cwd: fileURLToPath(root),
  encoding: "utf8",
}).replace(/from "([^"]+)"/g, (match, specifier) => {
  const url = specifier.startsWith(".")
    ? new URL(specifier, new URL("model/richtext-spans.mjs", root)).href
    : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});

export const baseline = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
export const resultOf = (validate, spans, limit) => {
  try {
    validate(spans, limit);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, name: error.name, message: error.message, code: error.code ?? null };
  }
};

export const text = (value, marks = {}) => ({ type: "text", value, marks });
export const marker = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type, parents, attrs, isEmbed },
});
