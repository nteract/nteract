// Adapted from rgbkrk/wordgard-automerge c9c6ea8 (BSD-3-Clause).
// Pages owns the native spans. This module projects them without a Markdown or
// ProseMirror round trip, including render-only wrappers with no native offset.
import * as A from "@automerge/automerge/slim";
import { Schema, Leaf, Plot, Mark, Node, Elt } from "wordgard/doc";
import {
  Doc,
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  LineBreak,
  Strong,
  Emphasis,
  Code,
  Blockquote,
  ListItem,
  OrderedList,
  BulletList,
} from "wordgard/types";

const safeUrl = (value) =>
  typeof value === "string" &&
  // Reject whitespace/control characters that can obscure a URL scheme.
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u0020\u007f]/.test(value) &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/^(https?|mailto|tel):/i, ""));
export const PagesLink = Mark.Type.define("PagesLink", {
  inclusive: false,
  validate(value) {
    if (!value || !safeUrl(value.href) || (value.title != null && typeof value.title !== "string"))
      throw Error("Invalid Pages link");
  },
  shape: {
    element: "a",
    attributes: (value) =>
      safeUrl(value.href)
        ? {
            href: value.href,
            ...(value.title ? { title: value.title } : {}),
            target: "_blank",
            rel: "noopener noreferrer",
          }
        : {},
  },
});
export const OpaqueBlock = Leaf.Type.define("PagesOpaque", {
  group: Node.Group.Content,
  selectable: true,
  validate(value) {
    if (!value || ["source", "importId", "kind"].some((k) => typeof value[k] !== "string"))
      throw Error("Invalid preserved Pages block");
  },
  shape: {
    structure: (value) =>
      Elt.mk("section", { class: "opaque", "data-pages-opaque": "true" }, [
        Elt.mk("pre", [value.source]),
      ]),
  },
});
export const PagesImage = Leaf.Type.define("PagesImage", {
  inline: true,
  selectable: true,
  validate(value) {
    if (!value || !safeUrl(value.src)) throw Error("Invalid Pages image");
  },
  shape: {
    structure: (value) =>
      safeUrl(value.src)
        ? Elt.mk("img", { src: value.src, alt: value.alt ?? "", title: value.title ?? "" })
        : Elt.mk("span", ["Image omitted"]),
  },
});
export const Aside = Plot.define("PagesAside", {
  group: Node.Group.Content,
  blockContent: Node.Group.Content,
  shape: { element: "aside" },
});
export const elements = [
  Doc,
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  LineBreak,
  Strong,
  Emphasis,
  Code,
  PagesLink,
  Blockquote,
  ListItem,
  OrderedList,
  BulletList,
  OpaqueBlock,
  PagesImage,
  Aside,
  ...[Strong, Emphasis, Code, PagesLink].map((mark) => Schema.Override.markTarget(mark, Leaf.Text)),
];
export const schema = Schema.define(elements);
export {
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  LineBreak,
  Strong,
  Emphasis,
  Code,
  Blockquote,
  ListItem,
  OrderedList,
  BulletList,
};
export const expand = { defaultExpand: "both", perMarkExpand: { link: "none", code: "none" } };
const markTypes = { strong: Strong, em: Emphasis, code: Code };
export function fromMarks(marks = {}) {
  return Object.entries(marks)
    .map(([name, value]) => {
      if (Object.hasOwn(markTypes, name) && value === true) return markTypes[name];
      if (name === "link" && typeof value === "string") {
        const parsed = JSON.parse(value);
        if (
          !parsed ||
          !safeUrl(parsed.href) ||
          (parsed.title != null && typeof parsed.title !== "string")
        )
          throw Error("Invalid Pages link");
        return PagesLink.of({ href: parsed.href, title: parsed.title ?? null });
      }
      throw Error(`Unsupported Pages rich mark: ${name}`);
    })
    .reduce((set, mark) => mark.addToSet(set), Mark.none);
}
export function toMarks(marks) {
  const result = {};
  for (const mark of marks) {
    const name = Object.keys(markTypes).find((name) => markTypes[name].type === mark.type);
    if (name) result[name] = true;
    else if (mark.type === PagesLink) {
      if (!safeUrl(mark.value.href)) throw Error("Invalid Pages link");
      result.link = JSON.stringify({ href: mark.value.href, title: mark.value.title ?? null });
    } else throw Error(`Unsupported Wordgard inline mark: ${mark.name}`);
  }
  return result;
}
export const markName = (mark) => Object.keys(toMarks([mark]))[0];
const strings = (attrs = {}) =>
  Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [k, A.isImmutableString(v) ? String(v) : v]),
  );
function descriptor(type, attrs = {}) {
  switch (type) {
    case "paragraph":
      return { tag: Paragraph };
    case "heading": {
      const level = Number(attrs.level ?? 1);
      if (!Number.isInteger(level) || level < 1 || level > 6)
        throw Error("Invalid Pages heading level");
      return { tag: Heading.of(level) };
    }
    case "code-block":
      return {
        tag: attrs.params
          ? CodeBlock.withMarks([CodeBlockLanguage.of(String(attrs.params))])
          : CodeBlock,
      };
    case "blockquote":
      return { tag: Blockquote };
    case "aside":
      return { tag: Aside };
    case "unordered-list-item":
      return { tag: ListItem, outer: BulletList };
    case "ordered-list-item":
      return { tag: ListItem, outer: OrderedList.of(1) };
    default:
      throw Error(`Unsupported Pages block: ${type}`);
  }
}

export function decode(spans) {
  const blocks = [],
    stack = [],
    wgToAm = [],
    amToWg = [];
  let wg = 0,
    am = 0;
  const boundary = () => {
    wgToAm[wg] = am;
    amToWg[am] ??= wg;
  };
  const append = (node) => (stack.at(-1)?.children ?? blocks).push(node);
  const open = (tag, native = false) => {
    boundary();
    stack.push({ tag, children: [] });
    wg++;
    if (native) am++;
    boundary();
    // Render-only wrappers share a native position. Prefer an editable interior.
    amToWg[am] = wg;
  };
  const close = () => {
    if (!stack.at(-1).tag.type.spec.inlineContent && !stack.at(-1).children.length) {
      open(Paragraph);
      close();
    }
    const frame = stack.pop();
    boundary();
    wg++;
    wgToAm[wg] = am;
    append(frame.tag.create(frame.children));
  };
  const ensureText = () => {
    if (!stack.at(-1)?.tag.type.spec.inlineContent) open(Paragraph);
  };
  const leaf = (node, length = 1) => {
    boundary();
    append(node);
    for (let i = 0; i < length; i++) {
      wg++;
      am++;
      boundary();
    }
  };
  for (const span of spans) {
    if (span.type === "text") {
      ensureText();
      const marks = fromMarks(span.marks);
      // Wordgard uses a LineBreak leaf for newlines in code and prose.
      span.value.split("\n").forEach((part, i) => {
        if (i) leaf(LineBreak);
        if (part) leaf(Leaf.text(part, marks), part.length);
      });
      continue;
    }
    if (span.type !== "block" || !span.value || !Array.isArray(span.value.parents))
      throw Error("Invalid Pages rich span");
    const value = span.value,
      type = String(value.type),
      attrs = strings(value.attrs);
    if (value.isEmbed) {
      ensureText();
      if (type === "hard-break") leaf(LineBreak);
      else if (type === "image") {
        if (!safeUrl(attrs.src)) throw Error("Invalid Pages image");
        leaf(PagesImage.of({ src: attrs.src, alt: attrs.alt ?? null, title: attrs.title ?? null }));
      } else throw Error(`Unsupported Pages embed: ${type}`);
      continue;
    }
    const outer = [];
    for (const parent of value.parents) {
      const d = descriptor(String(parent));
      if (d.outer) outer.push(d.outer);
      outer.push(d.tag);
    }
    const desc = type === "pages-opaque" ? null : descriptor(type, attrs);
    if (desc?.outer) outer.push(desc.outer);
    let common = 0;
    while (
      common < outer.length &&
      common < stack.length &&
      stack[common].tag.type === outer[common].type
    )
      common++;
    while (stack.length > common) close();
    for (let i = common; i < outer.length; i++) open(outer[i]);
    if (type === "pages-opaque") {
      leaf(
        OpaqueBlock.of({
          source: String(attrs.source ?? ""),
          importId: String(attrs.importId ?? ""),
          kind: String(attrs.kind ?? "markdown"),
        }),
      );
    } else open(desc.tag, true);
  }
  if (!blocks.length && !stack.length) open(Paragraph);
  // Empty list items and containers still need an editable paragraph.
  if (stack.length && !stack.at(-1).tag.type.spec.inlineContent && !stack.at(-1).children.length)
    open(Paragraph);
  while (stack.length) close();
  boundary();
  return { doc: schema.doc(blocks), map: { wgToAm, amToWg } };
}

export function encode(doc) {
  const spans = [];
  const marker = (type, parents, attrs = {}, isEmbed = false) =>
    spans.push({
      type: "block",
      value: {
        type: new A.ImmutableString(type),
        parents: parents.map((p) => new A.ImmutableString(p)),
        attrs: Object.fromEntries(
          Object.entries(attrs).map(([k, v]) => [
            k,
            typeof v === "string" ? new A.ImmutableString(v) : v,
          ]),
        ),
        isEmbed,
      },
    });
  const inline = (node, parents, code = false) => {
    if (node.isText)
      spans.push({ type: "text", value: String(node.param), marks: toMarks(node.marks) });
    else if (node.type === LineBreak.type) {
      if (code) spans.push({ type: "text", value: "\n", marks: toMarks(node.marks) });
      else marker("hard-break", parents, {}, true);
    } else if (node.type === PagesImage) marker("image", parents, node.param, true);
    else throw Error(`Unsupported Wordgard inline node: ${node.name}`);
  };
  const block = (node, parents, implicit = false, listType = null) => {
    if (node.type === OpaqueBlock) {
      marker("pages-opaque", parents, node.param);
      return;
    }
    if (!node.isPlot) throw Error(`Unsupported Wordgard block: ${node.name}`);
    if (node.type === BulletList.type || node.type === OrderedList) {
      if (node.type === OrderedList && node.tag.param !== 1)
        throw Error("Pages ordered lists currently start at 1");
      const itemType = node.type === BulletList.type ? "unordered-list-item" : "ordered-list-item";
      for (const child of node.content) block(child, parents, false, itemType);
      return;
    }
    let type,
      attrs = {};
    if (node.type === Paragraph.type) type = "paragraph";
    else if (node.type === Heading) {
      type = "heading";
      attrs.level = Number(node.tag.param);
    } else if (node.type === CodeBlock.type) {
      type = "code-block";
      attrs.params = String(node.mark(CodeBlockLanguage) ?? "");
    } else if (node.type === Blockquote.type) type = "blockquote";
    else if (node.type === Aside.type) type = "aside";
    else if (node.type === ListItem.type && listType) type = listType;
    else throw Error(`Unsupported Wordgard block: ${node.name}`);
    if (!(implicit && type === "paragraph")) marker(type, parents, attrs);
    if (node.inlineContent)
      for (const child of node.content) inline(child, [...parents, type], type === "code-block");
    else node.content.forEach((child, i) => block(child, [...parents, type], i === 0));
  };
  doc.content.forEach((node, i) => block(node, [], i === 0));
  return spans;
}
