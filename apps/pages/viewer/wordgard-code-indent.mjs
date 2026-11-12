import { Leaf, Plot } from "wordgard/doc";
import { Command, enter } from "wordgard/command";
import { KeyBinding } from "wordgard/editor";
import { GardSelection } from "wordgard/state";
import { CodeBlock, CodeBlockLanguage } from "./wordgard-model.mjs";
import { languageFor } from "./code-highlight.mjs";

// Indentation inside a code block. Tab indents, Shift-Tab removes one level,
// and Enter starts the new line at the indentation of the line it leaves.
// Outside a code block every command here returns false, so Tab keeps moving
// focus and Enter stays Wordgard's.
//
// A code block's content is text leaves and line breaks, each line break one
// position long, so an offset into the source text is an offset from the
// block's start.

export const sourceOf = (node) =>
  node.content.map((child) => (child.isText ? String(child.param) : "\n")).join("");

export const lineStart = (source, offset) => source.lastIndexOf("\n", offset - 1) + 1;
export const lineEnd = (source, offset) => {
  const end = source.indexOf("\n", offset);
  return end < 0 ? source.length : end;
};

/** The code block a text selection lies inside, both ends, or null. */
export function selectedCodeBlock(state) {
  if (!(state.selection instanceof GardSelection.Text)) return null;
  const block = state.sel.head.textblockParent;
  if (block?.node.type !== CodeBlock.type) return null;
  return state.sel.anchor.textblockParent?.start === block.start ? block : null;
}

/** The editable code block that holds the selection, with the selection as
 * offsets into its source. */
export function selectedCode(state) {
  const block = state.readOnly ? null : selectedCodeBlock(state);
  if (!block) return null;
  const { start } = block;
  return {
    block,
    start,
    source: sourceOf(block.node),
    from: state.selection.from - start,
    to: state.selection.to - start,
  };
}

// Four columns where the language's own formatter uses four; two elsewhere.
const FOUR_COLUMNS = new Set(["Python", "Rust"]);
const indentWidth = (language) => (FOUR_COLUMNS.has(languageFor(language)?.name) ? 4 : 2);

/** One level of indentation: a tab when a line of the block already starts
 * with one, otherwise spaces. */
export function indentUnit(source, language) {
  return /^\t/m.test(source) ? "\t" : " ".repeat(indentWidth(language));
}

/** Where each line the selection touches starts. A selection that ends at the
 * start of a line doesn't touch that line. */
export function touchedLines(source, from, to) {
  const starts = [];
  for (let start = lineStart(source, from); ; ) {
    if (start < to || !starts.length) starts.push(start);
    const end = source.indexOf("\n", start);
    if (end < 0 || end >= to) return starts;
    start = end + 1;
  }
}

/** The selection after `edits`, keeping its direction. Each edit is
 * `{ at, removed, inserted }` in source offsets, in ascending order. An edit
 * at the selection's own boundary stays outside it; with `assoc` 1, text
 * inserted there goes before it. */
export function selectionAfter(state, start, edits, assoc = -1) {
  const map = (pos) => {
    const offset = pos - start;
    let moved = offset;
    for (const { at, removed, inserted } of edits) {
      if (at > offset || (at === offset && (assoc < 0 || removed))) break;
      moved += inserted - Math.min(removed, offset - at);
    }
    return start + moved;
  };
  const { anchor, head } = state.selection;
  return GardSelection.Text.create({ anchor: map(anchor), head: map(head) });
}

/** Tab. With a caret, add spaces up to the next indentation column, or a tab
 * in a block that uses tabs. With a selection, indent every line it touches
 * that has text. */
export function indentCode({ state }) {
  const code = selectedCode(state);
  if (!code) return false;
  const { start, source, from, to } = code;
  const unit = indentUnit(source, code.block.node.mark(CodeBlockLanguage));
  if (from === to) {
    const column = from - lineStart(source, from);
    const insert = unit === "\t" ? unit : " ".repeat(unit.length - (column % unit.length));
    return {
      changes: { from: start + from, insert: [Leaf.text(insert)] },
      selection: GardSelection.cursor(start + from + insert.length),
      scrollIntoView: true,
      userEvent: "input.indent",
    };
  }
  const lines = touchedLines(source, from, to).filter((at) => lineEnd(source, at) > at);
  if (!lines.length) return true;
  return {
    changes: lines.map((at) => ({ from: start + at, insert: [Leaf.text(unit)] })),
    selection: selectionAfter(
      state,
      start,
      lines.map((at) => ({ at, removed: 0, inserted: unit.length })),
    ),
    scrollIntoView: true,
    userEvent: "input.indent",
  };
}

/** Shift-Tab. Remove one level from the start of every line the selection
 * touches: a tab, or up to one level of spaces. The key stays in the code
 * block when there's nothing to remove. */
export function dedentCode({ state }) {
  const code = selectedCode(state);
  if (!code) return false;
  const { start, source, from, to } = code;
  const level = new RegExp(`^(?:\\t| {1,${indentWidth(code.block.node.mark(CodeBlockLanguage))}})`);
  const edits = touchedLines(source, from, to).flatMap((at) => {
    const removed = level.exec(source.slice(at, lineEnd(source, at)))?.[0].length;
    return removed ? [{ at, removed, inserted: 0 }] : [];
  });
  if (!edits.length) return true;
  return {
    changes: edits.map(({ at, removed }) => ({ from: start + at, to: start + at + removed })),
    selection: selectionAfter(state, start, edits),
    scrollIntoView: true,
    userEvent: "delete.dedent",
  };
}

/** Enter on an indented line. The new line starts with the indentation
 * before the caret.
 *
 * On a line that holds only indentation the break goes in above it, so the
 * line left behind is empty rather than trailing spaces. A second Enter there
 * leaves the block the way Wordgard's Enter leaves it from two empty lines:
 * both lines go, and the caret lands in a new paragraph after the code.
 *
 * Returns false for a line with no indentation before the caret, which is
 * Wordgard's own Enter. */
export function enterIndentedCode({ state }) {
  const code = selectedCode(state);
  if (!code) return false;
  const { block, start, source, from, to } = code;
  const first = lineStart(source, from);
  const indent = /^[ \t]*/.exec(source.slice(first, from))[0];
  const brk = state.doc.schema.lineBreak;
  if (!indent || !brk) return false;
  const end = lineEnd(source, to);
  if (from === to && !source.slice(first, end).trim()) {
    const paragraph =
      block.parent && source.slice(0, first).endsWith("\n\n")
        ? state.doc.schema.defaultContentPlot(block.parent.node.type)
        : null;
    if (paragraph?.type.inlineContent) {
      const after = end === source.length ? [] : [block.node.tag];
      return {
        changes: {
          from: start + first - 2,
          to: start + end + 1,
          insert: [Plot.End, paragraph, Plot.End, ...after],
        },
        selection: GardSelection.cursor(start + first, -1),
        scrollIntoView: true,
        userEvent: "split.textblock",
      };
    }
    return {
      changes: { from: start + first, insert: [brk] },
      selection: GardSelection.cursor(start + from + 1),
      scrollIntoView: true,
      userEvent: "input",
    };
  }
  return {
    changes: { from: start + from, to: start + to, insert: [brk, Leaf.text(indent)] },
    selection: GardSelection.cursor(start + from + 1 + indent.length),
    scrollIntoView: true,
    userEvent: "input",
  };
}

// Wordgard prevents the default for every matched key unless the binding sets
// allowDefault. Outside a code block these commands return false, so
// allowDefault lets Tab and Shift-Tab move focus. Inside one, Mod-Enter or an
// arrow key leaves the block and Tab moves focus again.
export const codeIndentation = [
  Command.handler(enter, enterIndentedCode),
  KeyBinding.of({ key: "Tab", run: indentCode, allowDefault: true }),
  KeyBinding.of({ key: "Shift-Tab", run: dedentCode, allowDefault: true }),
];
