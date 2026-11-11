import * as A from "@automerge/automerge/slim";
import { nativeReadSpans } from "./native-read.mjs";
import { codeTextUnmarked, readSpans } from "./richtext-format.mjs";
import { nodeType, TEXT_CONTAINERS } from "./node-registry.mjs";
import { unknownNodeNotice } from "./richtext-notices.mjs";

const MAX_SPANS = 65536;
const MAX_PARENTS = 64;
const MAX_TEXT = 4 * 1024 * 1024;
const marker = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type, parents, attrs, isEmbed },
});
const container = (type) => !type || !nodeType(type) || nodeType(type).kind === "container";
const unknownWrapper = new A.ImmutableString("pages-preview-unknown");

/** Surface reads are bounded by size, span and depth budgets that the API
 * Markdown projection does not apply. */
export function surfaceRead(block) {
  if (block.richText.length > MAX_TEXT) throw Error("Surface text budget exceeded");
  const input = codeTextUnmarked(readSpans(block, ["richText"]));
  if (input.length > MAX_SPANS) throw Error("Surface span budget exceeded");
  for (const span of input)
    if (span.type === "block" && span.value.parents?.length > MAX_PARENTS)
      throw Error("Surface depth budget exceeded");
  try {
    return surfaceNodes(input, false);
  } catch (error) {
    if (
      !input.some(
        ({ type, value }) =>
          type === "block" &&
          ([value.type, ...(value.parents ?? [])].some((type) => !nodeType(type)) ||
            (String(value.type) === "dataframe" &&
              (value.parents ?? []).some((type) => TEXT_CONTAINERS.has(String(type))))),
      )
    )
      throw error;
    return surfaceNodes(input, true);
  }
}

// A refused placement retries once with unknown markers rendered as notices.
// Notices belong to the active text block, not their unplaceable parent hints.
function surfaceNodes(input, all) {
  const readable = [];
  for (const span of input) {
    const leaf = readable.at(-1)?.type === "block" ? readable.at(-1).value : null;
    if (
      (span.type !== "block" || span.value.isEmbed) &&
      leaf &&
      !leaf.isEmbed &&
      nodeType(leaf.type)?.kind === "leaf" &&
      String(leaf.type) !== "pages-opaque" &&
      !(leaf.parents ?? []).some((p) => TEXT_CONTAINERS.has(String(p)))
    )
      readable.push(marker(new A.ImmutableString("paragraph"), leaf.parents));
    if (span.type !== "block") {
      readable.push(span);
      continue;
    }
    const { type, parents = [], isEmbed } = span.value;
    const name = String(type),
      textOnly = parents.some((p) => TEXT_CONTAINERS.has(String(p)));
    const unknown = !nodeType(name) || (name === "dataframe" && textOnly);
    if (!unknown || !(all || (isEmbed && parents.some((p) => String(p) === "code-block")))) {
      readable.push(span);
      continue;
    }
    readable.push(
      ...(!isEmbed && !textOnly
        ? [
            marker(
              new A.ImmutableString("paragraph"),
              parents.filter((p) => nodeType(p)).map((p) => new A.ImmutableString(String(p))),
            ),
          ]
        : []),
      { type: "text", value: unknownNodeNotice(name), marks: {} },
    );
  }
  input = readable;
  const spans = [];
  let context = [];
  let following = null;
  for (let index = 0; index < input.length; index++) {
    const span = input[index];
    if (span.type === "block") {
      const raw = span.value,
        name = String(raw.type),
        parents = (raw.parents ?? []).map(String);
      if (
        !raw.isEmbed &&
        name !== "dataframe" &&
        nodeType(name)?.kind === "leaf" &&
        parents.some((p) => TEXT_CONTAINERS.has(p)) &&
        input[index + 1] &&
        (input[index + 1].type === "text" || input[index + 1].value.isEmbed)
      )
        throw Error("Unreadable text after a nested leaf");
    }
    if (span.type === "text") {
      if (following) {
        spans.push(following);
        context = [...following.value.parents, following.value.type];
      }
      following = null;
      if (container(context.at(-1))) context = [...context, "paragraph"];
      spans.push(span);
      continue;
    }
    // Mutable marker fields have a defined legacy read spelling. These copies
    // are projection inputs only; no Automerge bytes or IDs are rewritten.
    const value = span.value;
    let type =
      value.type instanceof A.ImmutableString ? value.type : new A.ImmutableString("paragraph");
    let parents =
      Array.isArray(value.parents) && value.parents.every((p) => p instanceof A.ImmutableString)
        ? value.parents
        : [];
    if (all && (value.parents ?? []).some((parent) => !nodeType(parent)))
      parents = value.parents
        .filter((parent) => nodeType(parent))
        .map((parent) => new A.ImmutableString(String(parent)));
    if (parents.length > MAX_PARENTS) throw Error("Surface depth budget exceeded");
    const attrs = { ...value.attrs },
      name = String(type),
      def = nodeType(name);
    let isEmbed = !!value.isEmbed;
    if (name === "image" && attrs.src === undefined) throw Error("Unreadable image attributes");
    if (name === "dataframe" && (attrs?.src === undefined || attrs?.media_type === undefined))
      throw Error("Unreadable dataframe attributes");
    if (isEmbed) {
      if (def && def.kind !== "embed") {
        if (!container(context.at(-1))) throw Error("Unreadable embedded block");
        if (name === "table-cell" || name === "table-header") {
          if (context.at(-1) !== "table-row") {
            if (context.at(-1) !== "table") context = [...context, "table"];
            context = [...context, "table-row"];
          }
          spans.push(marker(name, context, attrs));
          following = marker("table-cell", context);
          continue;
        }
        if (
          ["table", "table-row"].includes(context.at(-1)) ||
          !(def.kind === "text" || def.kind === "leaf" || name === "code-block")
        )
          throw Error("Unreadable embedded block");
        // An empty standalone block cannot absorb the following inline text.
        spans.push(marker(name, context, attrs));
        following = marker("paragraph", context);
        continue;
      } else {
        if (context.at(-1) === "code-block" && (name === "hard-break" || !def))
          throw Error("Unreadable code embed");
        if (following) {
          spans.push(following);
          context = [...following.value.parents, following.value.type];
        }
        following = null;
        if (container(context.at(-1))) context = [...context, "paragraph"];
      }
    } else {
      if (
        ((!def || name === "dataframe") && parents.some((p) => TEXT_CONTAINERS.has(String(p)))) ||
        (name === "dataframe" &&
          (value.parents ?? []).some((p) => TEXT_CONTAINERS.has(String(p))) &&
          input[index + 1] &&
          (input[index + 1].type === "text" || input[index + 1].value.isEmbed))
      )
        throw Error("Unreadable native notice placement");
      if (def?.kind === "embed") {
        const next = input[index + 1];
        const path = parents.map(String);
        if (
          (next && (next.type === "text" || next.value.isEmbed)) ||
          !["paragraph", "heading", "table-cell", "table-header"].includes(path.at(-1))
        )
          throw Error("Unreadable block-form inline node");
        if (path.length !== context.length || path.some((type, index) => context[index] !== type))
          spans.push(marker(path.at(-1), path.slice(0, -1)));
        spans.push(marker(name, path, attrs, true));
        context = path;
        following = null;
        continue;
      }
      const path = [...parents.map(String), name];
      for (let i = 0; i < path.length; i++) {
        const parentKind = nodeType(path[i])?.kind;
        const cell = path[i] === "table-cell" || path[i] === "table-header";
        if (
          (i < path.length - 1 && (parentKind === "leaf" || parentKind === "embed")) ||
          (path[i] === "table-row" && path[i - 1] !== "table") ||
          (cell && path[i - 1] !== "table-row") ||
          (i > 0 && path[i - 1] === "table" && path[i] !== "table-row") ||
          (i > 0 && path[i - 1] === "table-row" && !cell)
        )
          throw Error("Unreadable structural parent");
      }
      if (
        parents.some(
          (p) =>
            nodeType(p)?.kind === "text" ||
            (TEXT_CONTAINERS.has(String(p)) && def && name !== "dataframe"),
        )
      )
        throw Error("Unreadable nested block");
      following = null;
      // Surface wrappers have one generic visible identity. Different unknown
      // parent names must not split a group and consume extra card node budget.
      parents = parents.map((parent) => (nodeType(parent) ? parent : unknownWrapper));
      if (!def) type = unknownWrapper;
      context = [...parents.map(String), ...(def?.kind === "leaf" ? [] : [String(type)])];
    }
    spans.push({ ...span, value: { type, parents, attrs, isEmbed } });
  }
  return nativeReadSpans(spans);
}
