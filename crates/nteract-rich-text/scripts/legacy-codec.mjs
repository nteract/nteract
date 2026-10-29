import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The compatibility oracle intentionally uses the existing Pages dependencies.
// It is a test-only adapter and is not a second production codec.
export const pagesRoot = fileURLToPath(
  new URL("../../../docs/memos/authenticated-automerge-app-substrate/experiment/pages/", import.meta.url),
);
const require = createRequire(resolve(pagesRoot, "package.json"));
const { pmNodeToSpans, pmDocFromSpans } = await import(
  pathToFileURL(require.resolve("@automerge/prosemirror")).href
);
const { adapter, parseMarkdown, exportMarkdown } = await import(
  pathToFileURL(resolve(pagesRoot, "model/richtext.mjs")).href
);
const { ImmutableString } = require("@automerge/automerge/slim");

export function importLegacy(markdown, importId = "", kind = "markdown") {
  return JSON.parse(JSON.stringify(pmNodeToSpans(adapter, parseMarkdown(markdown, importId, kind))));
}

export function exportLegacy(spans) {
  const hydrated = spans.map((span) =>
    span.type === "text"
      ? span
      : {
          ...span,
          value: {
            ...span.value,
            type: new ImmutableString(span.value.type),
            parents: span.value.parents.map((parent) => new ImmutableString(parent)),
            attrs: Object.fromEntries(
              Object.entries(span.value.attrs).map(([name, value]) => [
                name,
                typeof value === "string" ? new ImmutableString(value) : value,
              ]),
            ),
          },
        },
  );
  return exportMarkdown(pmDocFromSpans(adapter, hydrated));
}

// Automerge may split adjacent text spans at change boundaries. Coalescing
// identical marks is the only normalization used by the compatibility tests.
export function normalizeSpans(spans) {
  const result = [];
  for (const span of spans) {
    const previous = result.at(-1);
    const sameMarks =
      span.type === "text" &&
      previous?.type === "text" &&
      JSON.stringify(Object.entries(span.marks ?? {}).sort()) ===
        JSON.stringify(Object.entries(previous.marks ?? {}).sort());
    if (sameMarks) previous.value += span.value;
    else result.push(structuredClone(span));
  }
  return result;
}
