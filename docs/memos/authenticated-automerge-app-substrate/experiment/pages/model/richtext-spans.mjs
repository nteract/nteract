// Native span validation and editor-tree encoding. Read projections live in native-read.
import * as A from "@automerge/automerge/slim";
import { markSpec, safeUrl, validateMarkValue } from "./marks.mjs";
import {
  TEXT_CONTAINERS,
  isKnownBlock,
  nodeType,
  validAlignment,
  validHeadingLevel,
} from "./node-registry.mjs";
import { DATAFRAME_BLOCK, parseAssetPath, readDataframe } from "../shared/dataset-assets.mjs";
import { decode, encode, schema } from "./wordgard-doc.mjs";
import { treeMarkdown } from "./markdown-serializer.mjs";
import { codeTextUnmarked, isRich } from "./richtext-format.mjs";

export const readTree = (block) => decode(codeTextUnmarked(A.spans(block, ["richText"]))).doc;
export const richDoc = readTree;
export const pageSpans = encode;

/** The first stored type a Markdown rewrite cannot reproduce. */
export function markdownlessNode(block, pageId) {
  if (!isRich(block)) return null;
  for (const span of A.spans(block, ["richText"])) {
    if (span.type !== "block") continue;
    const type = String(span.value.type),
      parents = (span.value.parents ?? []).map(String);
    if (
      type === DATAFRAME_BLOCK &&
      (parents.some((parent) => TEXT_CONTAINERS.has(parent)) ||
        (pageId !== undefined &&
          parseAssetPath(String(span.value.attrs?.src ?? ""))?.pageId !== pageId))
    )
      return DATAFRAME_BLOCK;
    for (const name of [type, ...parents]) if (!isKnownBlock(name)) return name;
  }
  return null;
}

export const validateRich = (block) => validateRichSpans(A.spans(block, ["richText"]));

/** Admission checks stored envelopes and attributes before asking the native schema
 * to validate structure. A tolerant read projection cannot authorize a write. */
export function validateRichSpans(spans, maxBytes = 262144) {
  if (new TextEncoder().encode(JSON.stringify(spans)).length > maxBytes)
    throw Error("Rich block exceeds content limit");
  for (const span of spans) {
    if (span.type === "text") {
      if (typeof span.value !== "string") throw Error("Invalid rich text");
      for (const [name, value] of Object.entries(span.marks ?? {})) {
        markSpec(name);
        try {
          validateMarkValue(name, value);
        } catch {
          throw Error(name === "link" ? "Invalid rich link" : "Invalid rich mark value");
        }
      }
    } else if (span.type === "block") {
      const value = span.value;
      if (
        !value ||
        Object.keys(value).some((k) => !["type", "parents", "attrs", "isEmbed"].includes(k)) ||
        !Array.isArray(value.parents) ||
        value.parents.length > 32 ||
        !isKnownBlock(value.type)
      )
        throw Error("Unsupported rich block marker");
      for (const parent of value.parents)
        if (!isKnownBlock(parent)) throw Error("Unsupported rich parent");
      const type = String(value.type),
        attrs = value.attrs ?? {};
      if (
        typeof value.isEmbed !== "boolean" ||
        value.isEmbed !== (nodeType(type).kind === "embed") ||
        typeof attrs !== "object" ||
        Array.isArray(attrs)
      )
        throw Error("Invalid rich block shape");
      if (type === "task-list-item" && typeof attrs.checked !== "boolean")
        throw Error("Invalid task checked state");
      if (type === "heading" && !validHeadingLevel(attrs.level ?? 1))
        throw Error("Invalid heading level");
      if (
        ["table-cell", "table-header"].includes(type) &&
        attrs.align != null &&
        !validAlignment(String(attrs.align))
      )
        throw Error("Invalid table alignment");
      if (
        type === "image" &&
        (!safeUrl(String(attrs.src ?? "")) ||
          (attrs.dark_src != null && !safeUrl(String(attrs.dark_src))))
      )
        throw Error("Invalid rich image URL");
      if (
        type === DATAFRAME_BLOCK &&
        !readDataframe(
          Object.fromEntries(
            Object.entries(attrs).map(([k, v]) => [k, A.isImmutableString(v) ? String(v) : v]),
          ),
        )
      )
        throw Error("Invalid dataframe: src must be a Page asset path");
    } else throw Error("Unsupported rich span");
  }
  const decoded = decode(codeTextUnmarked(spans));
  if (decoded.lossy) throw Error("Rich text contains content the native schema cannot place");
  schema.validate(decoded.doc);
  treeMarkdown(decoded.doc);
}
