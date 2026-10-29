import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

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

export function javaScriptDocumentFixture(markdown, wordgard = false) {
  // Resolve the ESM exports exactly as Pages does. Mixing the package's CJS
  // and ESM ImmutableString classes changes how attributes are stored.
  const script = `
    import fs from "node:fs";
    import * as A from "@automerge/automerge";
    import { pmNodeToSpans } from "@automerge/prosemirror";
    import { adapter, parseMarkdown } from "./model/richtext.mjs";
    import { decode, encode } from "./viewer/wordgard-model.mjs";
    const { markdown, wordgard } = JSON.parse(fs.readFileSync(0, "utf8"));
    const imported = pmNodeToSpans(adapter, parseMarkdown(markdown));
    const spans = wordgard ? encode(decode(imported).doc) : imported;
    const actor = "11111111111111111111111111111111";
    let doc = A.init({ actor });
    doc = A.change(doc, { time: 0 }, (draft) => { draft.content = ""; });
    doc = A.change(doc, { time: 0 }, (draft) => {
      A.updateSpans(draft, ["content"], spans, adapter.updateSpansConfig());
    });
    const result = { markdown, actor, heads: A.getHeads(doc), bytes_hex: Buffer.from(A.save(doc)).toString("hex"), spans };
    A.free(doc);
    process.stdout.write(JSON.stringify(result));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: pagesRoot,
    input: JSON.stringify({ markdown, wordgard }),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }));
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
