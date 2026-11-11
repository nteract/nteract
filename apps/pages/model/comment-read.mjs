// Comment reads have no writer or editor-schema dependency. Legacy tolerance
// here projects stored content only; it never makes that content admissible.
import * as A from "@automerge/automerge/slim";
import { codeTextUnmarked } from "./richtext-format.mjs";
import { PLAIN_FORMAT, plainCommentText } from "./comment-text.mjs";
import { nativeReadSpans, readChildren, readKind, readMarkdown } from "./native-read.mjs";
import { isKnownBlock, nodeType, TEXT_CONTAINERS } from "./node-registry.mjs";
import { unknownNodeNotice } from "./richtext-notices.mjs";

const unreadable = () => {
  throw Object.assign(Error("Unreadable comment spans"), { code: "unreadable_comment_spans" });
};
const dataframeInText = (type, parents) =>
  type === "dataframe" && parents.some((parent) => TEXT_CONTAINERS.has(parent));
const marker = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type, parents, attrs, isEmbed },
});

// Notice placement precedes legacy marker normalization. In a fallback, every
// unknown node becomes a notice, including earlier nodes that were placeable.
function commentNoticeSpans(spans, all) {
  const out = [];
  const known = (parents) =>
    parents.filter(isKnownBlock).map((type) => new A.ImmutableString(type));
  for (const span of spans) {
    const leaf = out.at(-1)?.type === "block" ? out.at(-1).value : null;
    if (
      (span.type !== "block" || span.value?.isEmbed) &&
      leaf &&
      !leaf.isEmbed &&
      nodeType(leaf.type)?.kind === "leaf" &&
      String(leaf.type) !== "pages-opaque" &&
      !leaf.parents.some((parent) => TEXT_CONTAINERS.has(String(parent)))
    )
      out.push(marker(new A.ImmutableString("paragraph"), leaf.parents));
    if (span.type !== "block") {
      out.push(span);
      continue;
    }
    const type = String(span.value.type),
      parents = (span.value.parents ?? []).map(String);
    const unknown = !isKnownBlock(type) || dataframeInText(type, parents);
    if (unknown && (all || (span.value.isEmbed && parents.includes("code-block")))) {
      if (!span.value.isEmbed && !parents.some((parent) => TEXT_CONTAINERS.has(parent)))
        out.push(marker(new A.ImmutableString("paragraph"), known(parents)));
      out.push({ type: "text", value: unknownNodeNotice(type), marks: {} });
    } else if (all && parents.some((parent) => !isKnownBlock(parent)))
      out.push({ ...span, value: { ...span.value, parents: known(parents) } });
    else out.push(span);
  }
  return out;
}

function commentReadSpans(spans) {
  let context = [];
  const container = (type) => !type || !isKnownBlock(type) || nodeType(type)?.kind === "container";
  return spans.flatMap((span, index, input) => {
    if (span.type === "text") {
      if (context.at(-1) === "code-block" && Object.keys(span.marks ?? {}).length) unreadable();
      if (container(context.at(-1))) context = [...context, "paragraph"];
      return span;
    }
    const value = span.value;
    // Mutable marker names and parent lists have an established literal
    // reading. Normalize copies, never the Automerge source or its writers.
    const type = A.isImmutableString(value.type) ? String(value.type) : "paragraph";
    let parents =
      Array.isArray(value.parents) && value.parents.every(A.isImmutableString)
        ? value.parents.map(String)
        : [];
    const attrs = value.attrs && typeof value.attrs === "object" ? { ...value.attrs } : {};
    if (type === "task-list-item") attrs.checked = attrs.checked === true;
    const isEmbed = !!value.isEmbed;
    const next = input[index + 1];
    const inlineNext = next && (next.type !== "block" || next.value?.isEmbed);
    const nextType =
      next?.type === "block" && A.isImmutableString(next.value.type)
        ? String(next.value.type)
        : "paragraph";
    const inlineContentNext =
      inlineNext &&
      (next.type !== "block" || !isKnownBlock(nextType) || nodeType(nextType)?.kind === "embed");
    if (!isEmbed && dataframeInText(type, parents)) unreadable();
    if (isEmbed) {
      if (context.at(-1) === "code-block" && !isKnownBlock(type)) unreadable();
      if (type === "hard-break" && context.at(-1) === "code-block") unreadable();
      if (isKnownBlock(type) && nodeType(type).kind !== "embed") {
        if (!container(context.at(-1))) unreadable();
        if (["table-cell", "table-header"].includes(type)) {
          if (context.at(-1) !== "table-row") {
            if (context.at(-1) !== "table") context = [...context, "table"];
            context = [...context, "table-row"];
          }
          return [
            marker(type, context, attrs),
            ...(inlineContentNext ? [marker("table-cell", context)] : []),
          ];
        }
        if (
          ["table", "table-row"].includes(context.at(-1)) ||
          !["paragraph", "heading", "code-block", "horizontal-rule", "dataframe"].includes(type)
        )
          unreadable();
        return [
          marker(type, context, attrs),
          ...(inlineContentNext ? [marker("paragraph", context)] : []),
        ];
      }
      if (container(context.at(-1))) context = [...context, "paragraph"];
    } else {
      // All stored parent transitions must be placeable; a missing table row
      // cannot be invented just because the final parent accepts text.
      const chain = nodeType(type)?.kind === "embed" ? parents : [...parents, type];
      for (let i = 0; i < chain.length; i++) {
        const parent = chain[i - 1],
          child = chain[i],
          spec = nodeType(parent);
        if (parent === "table" || parent === "table-row") {
          if (
            parent === "table"
              ? child !== "table-row"
              : !["table-cell", "table-header"].includes(child)
          )
            unreadable();
        } else if (
          (spec && spec.kind !== "container") ||
          ["table-row", "table-cell", "table-header"].includes(child)
        )
          unreadable();
      }
      // Unknown wrappers share one read grouping. Reuse the open wrapper's
      // real label only along the common prefix, keeping its first notice.
      for (let i = 0; i < parents.length && i < context.length; i++) {
        if (!isKnownBlock(parents[i]) && !isKnownBlock(context[i])) parents[i] = context[i];
        else if (parents[i] !== context[i]) break;
      }
      if (nodeType(type)?.kind === "leaf" && inlineNext) unreadable();
      if (nodeType(type)?.kind === "embed") {
        if (
          inlineNext ||
          !["paragraph", "heading", "table-cell", "table-header"].includes(parents.at(-1))
        )
          unreadable();
        const open =
          context.length === parents.length && context.every((type, i) => type === parents[i])
            ? []
            : [marker(parents.at(-1), parents.slice(0, -1))];
        context = parents;
        return [...open, marker(type, parents, attrs, true)];
      }
      context = [...parents, type];
      if (nodeType(type)?.kind === "leaf") context = parents;
    }
    return marker(type, parents, attrs, isEmbed);
  });
}

function commentNodes(nodes) {
  for (const node of nodes) {
    const kind = readKind(node),
      children = readChildren(node);
    if (kind === "code-block" && children.some((child) => !child.isText)) unreadable();
    if (kind === "image" && node.param.src === undefined) unreadable();
    if (
      kind === "dataframe" &&
      (node.param.src === undefined || node.param.media_type === undefined)
    )
      unreadable();
    commentNodes(children);
  }
  return nodes;
}

export function commentMarkdown(message) {
  return commentBodyProjection(message).body;
}

/** Literal comments omit body_format until their spans contain formatting.
 * Unreadable rich text fails per message, never per thread or Page. No read
 * repairs or overwrites shared content. */
export function commentBodyProjection(message) {
  try {
    const spans = A.spans(message, ["richText"]);
    if (String(message.bodyFormat ?? "") === PLAIN_FORMAT) {
      const text = plainCommentText(spans);
      if (text !== null) return { body: text };
    }
    const unmarked = codeTextUnmarked(spans);
    const read = (all) =>
      readMarkdown(
        commentNodes(nativeReadSpans(commentReadSpans(commentNoticeSpans(unmarked, all))).nodes),
      );
    let body;
    try {
      body = read(false);
    } catch (error) {
      // Retry eligibility is the first raw unknown name. An empty name is
      // falsy even when a later marker would otherwise permit a retry.
      let unknown;
      for (const span of unmarked) {
        if (span.type !== "block") continue;
        const type = String(span.value.type),
          parents = (span.value.parents ?? []).map(String);
        unknown = dataframeInText(type, parents)
          ? "dataframe"
          : [type, ...parents].find((name) => !isKnownBlock(name));
        if (unknown !== undefined) break;
      }
      const incompatible =
        error?.code === "unreadable_comment_spans" ||
        (error instanceof Error &&
          /^(Match cannot be null|Token type `[^`]*` not supported by Markdown renderer)$/.test(
            error.message,
          ));
      if (!unknown || !incompatible) throw error;
      body = read(true);
    }
    return { body, body_format: "markdown" };
  } catch {
    return {
      body:
        typeof message.richText === "string"
          ? message.richText.replaceAll("\ufffc", "\n").trim()
          : "",
      body_format: "plain",
      content_error: "rich_text_unavailable",
    };
  }
}

// JSON values omit marks and table marker attributes; change feeds need spans.
export function commentMessageState(message) {
  try {
    return { ...message, spans: A.spans(message, ["richText"]) };
  } catch {
    return { ...message, content_error: "rich_text_unavailable" };
  }
}
export function commentThreadState(thread) {
  return {
    ...thread,
    messages: Object.fromEntries(
      Object.entries(thread.messages ?? {}).map(([id, message]) => [
        id,
        commentMessageState(message),
      ]),
    ),
  };
}
