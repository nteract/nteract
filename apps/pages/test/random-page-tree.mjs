// Shrinkable, JSON-friendly descriptions, independent of the Pages codecs.
// These profiles exclude unknown/opaque nodes and asides. Wordgard
// validity alone does not imply Markdown representability: empty paragraphs
// and hostile syntax deliberately exercise the projection's limits.
import fc from "fast-check";
import { Leaf, Mark } from "wordgard/doc";
import {
  Alignment,
  Blockquote,
  BulletList,
  Cell,
  Code,
  CodeBlock,
  CodeBlockLanguage,
  Emphasis,
  HeaderCell,
  Heading,
  HorizontalRule,
  LineBreak,
  ListItem,
  OrderedList,
  PagesDataframe,
  PagesHighlight,
  PagesImage,
  PagesLink,
  Paragraph,
  Strikethrough,
  Strong,
  Table,
  TableRow,
  TaskChecked,
  TaskList,
  schema,
} from "../viewer/wordgard-model.mjs";

export const PAGE_ID = "55555555-5555-4555-8555-555555555555";

const words = ["a", "alpha", "42", "über", "naïve", "東京", "e\u0301", "😀", "👩‍💻"];
const hostilePieces = [
  ..."*_[]()#>-+|`~!<&$\\:.",
  "1.",
  "- ",
  "**",
  "__",
  "```",
  "<mark>",
  "&amp;",
  "&#10;",
  "[x]",
  "---",
  "  ",
  "\u00a0",
];
const listKinds = new Set(["bullet", "ordered", "task"]);
const text = (value, marks = {}) => ({ kind: "text", value, marks });
// JSON restores ordinary object prototypes, including embed and mark attrs.
const record = (fields) => fc.record(fields, { noNullPrototype: true });

// The separator is part of the generated input, not a codec normalization.
// Markdown cannot distinguish two adjacent lists with the same marker kind.
function siblings(block, maxLength, separateQuotes) {
  return fc.array(block, { minLength: 1, maxLength }).map((blocks) => {
    const children = [];
    for (const child of blocks) {
      if (
        (listKinds.has(child.kind) || (separateQuotes && child.kind === "quote")) &&
        children.at(-1)?.kind === child.kind
      )
        children.push({ kind: "rule" });
      children.push(child);
    }
    return children;
  });
}

/** maxDepth bounds quote/list nesting; table rows and inline nodes are leaves
 * for this budget. All shrinking operates on data, never on encoded spans. */
export function pageTreeArbitrary({
  hostile = false,
  maxDepth = 3,
  emptyParagraphs = true,
  separateQuotes = false,
} = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 0)
    throw new RangeError("maxDepth must be a nonnegative integer");
  const phrase = fc
    .array(fc.constantFrom(...words, ...(hostile ? hostilePieces : [])), {
      minLength: 1,
      maxLength: 3,
    })
    .map((parts) => parts.join(" "));
  const link = fc.option(
    record({
      href: fc.constantFrom("https://example.org/a", "https://example.org/b?q=1", "/relative"),
      title: fc.constantFrom(null, "Title"),
    }),
    { nil: null },
  );
  const marks = fc.oneof(
    { withCrossShrink: true },
    fc.constant({}),
    record({
      strong: fc.boolean(),
      em: fc.boolean(),
      strike: fc.boolean(),
      link,
      highlight: fc.constantFrom(null, "yellow", "green", "blue", "pink", "#a1b2c3"),
    }).map(({ strong, em, strike, link, highlight }) => ({
      ...(strong ? { strong: true } : {}),
      ...(em ? { em: true } : {}),
      ...(strike ? { strike: true } : {}),
      ...(link ? { link } : {}),
      ...(highlight ? { highlight } : {}),
    })),
    // Code spans may have a wrapping link, but no other formatting.
    link.map((link) => ({ code: true, ...(link ? { link } : {}) })),
  );
  const image = record({
    kind: fc.constant("image"),
    attrs: record({
      src: fc.constantFrom(
        "https://example.org/i.png",
        `/api/pages/${PAGE_ID}/assets/${"a".repeat(64)}`,
      ),
      alt: hostile ? phrase : fc.constantFrom("", "chart", "a picture"),
      title: fc.constantFrom(null, "Image title"),
    }),
  });
  const run = record({ kind: fc.constant("text"), value: phrase, marks });
  const inline = ({ breaks = true, images = true, empty = false } = {}) =>
    fc
      .array(
        record({
          node: images ? fc.oneof({ withCrossShrink: true }, run, run, image) : run,
          breakBefore: breaks ? fc.boolean() : fc.constant(false),
        }),
        { minLength: empty ? 0 : 1, maxLength: 3 },
      )
      .map((runs) =>
        runs.flatMap(({ node, breakBefore }, index) =>
          index ? [breakBefore ? { kind: "break" } : text(" "), node] : [node],
        ),
      );
  const paragraph = record({
    kind: fc.constant("paragraph"),
    children: inline({ empty: emptyParagraphs }),
  });
  const code = record({
    kind: fc.constant("code"),
    language: fc.constantFrom(null, "js", "python", "sh"),
    children: fc
      .array(phrase, { minLength: 1, maxLength: 3 })
      .map((lines) =>
        lines.flatMap((line, index) => (index ? [{ kind: "break" }, text(line)] : [text(line)])),
      ),
  });
  const table = fc.integer({ min: 1, max: 3 }).chain((rowCount) =>
    fc
      .array(
        record({
          align: fc.constantFrom(null, "left", "center", "right"),
          cells: fc.array(inline({ breaks: false, images: false }), {
            minLength: rowCount + 1,
            maxLength: rowCount + 1,
          }),
        }),
        { minLength: 1, maxLength: 3 },
      )
      .map((columns) => ({
        kind: "table",
        children: Array.from({ length: rowCount + 1 }, (_, row) => ({
          kind: "row",
          children: columns.map(({ align, cells }) => ({
            kind: row === 0 ? "header" : "cell",
            align,
            children: cells[row],
          })),
        })),
      })),
  );
  const terminal = fc.oneof(
    { withCrossShrink: true },
    paragraph,
    record({
      kind: fc.constant("heading"),
      level: fc.integer({ min: 1, max: 6 }),
      children: inline({ breaks: hostile }),
    }),
    code,
    fc.constant({ kind: "rule" }),
    table,
    record({
      kind: fc.constant("dataframe"),
      attrs: record({
        src: fc
          .constantFrom("b", "c")
          .map((hash) => `/api/pages/${PAGE_ID}/assets/${hash.repeat(64)}`),
        media_type: fc.constant("application/vnd.apache.parquet"),
        title: fc.constantFrom(null, "Usage"),
        // The native writer omits an absent title rather than storing null.
      }).map(({ title, ...attrs }) => ({ ...attrs, ...(title !== null && { title }) })),
    }),
  );
  function block(depth) {
    if (depth === 0) return terminal;
    const children = siblings(block(depth - 1), 3, separateQuotes);
    return fc.oneof(
      { withCrossShrink: true },
      terminal,
      record({ kind: fc.constant("quote"), children }),
      ...["bullet", "ordered", "task"].map((kind) =>
        record({
          kind: fc.constant(kind),
          ...(kind === "ordered" ? { start: fc.constant(1) } : {}),
          children: fc.array(
            record({
              kind: fc.constant("item"),
              ...(kind === "task" ? { checked: fc.boolean() } : {}),
              // No paragraph prefix: block-first and nested-only items are inputs.
              children,
            }),
            { minLength: 1, maxLength: 3 },
          ),
        }),
      ),
    );
  }
  return record({
    kind: fc.constant("doc"),
    children: siblings(block(maxDepth), 4, separateQuotes),
  });
}

/** Construct the independent expected tree using only Wordgard constructors. */
export function toWordgardTree(description) {
  function node(value) {
    const children = () => value.children.map(node);
    switch (value.kind) {
      case "doc":
        return schema.doc(children());
      case "text": {
        const types = {
          strong: Strong,
          em: Emphasis,
          strike: Strikethrough,
          code: Code,
        };
        const marks = Object.entries(value.marks).reduce((set, [name, data]) => {
          const mark =
            name === "link"
              ? PagesLink.of(data)
              : name === "highlight"
                ? PagesHighlight.of(data)
                : types[name];
          return mark.addToSet(set);
        }, Mark.none);
        return Leaf.text(value.value, marks);
      }
      case "break":
        return LineBreak;
      case "paragraph":
        return Paragraph.create(children());
      case "heading":
        return Heading.of(value.level).create(children());
      case "code":
        return (
          value.language === null
            ? CodeBlock
            : CodeBlock.withMarks([CodeBlockLanguage.of(value.language)])
        ).create(children());
      case "rule":
        return HorizontalRule;
      case "quote":
        return Blockquote.create(children());
      case "bullet":
        return BulletList.create(children());
      case "ordered":
        return OrderedList.of(value.start).create(children());
      case "task":
        return TaskList.create(children());
      case "item":
        return (
          typeof value.checked === "boolean"
            ? ListItem.withMarks([TaskChecked.of(value.checked)])
            : ListItem
        ).create(children());
      case "table":
        return Table.create(children());
      case "row":
        return TableRow.create(children());
      case "header":
      case "cell": {
        const type = value.kind === "header" ? HeaderCell : Cell;
        return (value.align === null ? type : type.withMarks([Alignment.of(value.align)])).create(
          children(),
        );
      }
      case "image":
        return PagesImage.of(value.attrs);
      case "dataframe":
        return PagesDataframe.of(value.attrs);
      default:
        throw new Error(`Unknown generated node kind: ${value.kind}`);
    }
  }
  return node(description);
}
