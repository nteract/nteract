import { ChangeSet, Node, Plot } from "wordgard/doc";
import { GardSelection } from "wordgard/state";
import { InputRule, KeyBinding } from "wordgard/editor";
import {
  Command,
  enter,
  setTextblockType,
  toggleBlock,
  toggleList,
  toggleMark,
} from "wordgard/command";
import { blockquote, bulletList, heading, horizontalRule, orderedList } from "wordgard/schema";
import { history } from "wordgard/history";
import {
  Code,
  CodeBlock,
  CodeBlockLanguage,
  Emphasis,
  Heading,
  ListItem,
  Paragraph,
  Strikethrough,
  Strong,
} from "./wordgard-model.mjs";
import { taskListInputRule } from "./wordgard-task-lists.mjs";

// Shift+Enter and pasted <br> write LineBreak leaves, so one paragraph can show
// several visual lines. Wordgard's block shortcuts and block commands work on whole
// textblocks. The helpers here split a paragraph at the hard breaks around a
// line first, then hand the new paragraph to the stock Wordgard behavior.
//
// A split replaces LineBreak leaves with a paragraph boundary. The text on
// either side keeps its tokens, so the binding keeps its Automerge characters
// and the comments and cursors anchored to them.

// The TextblockMap stands in U+FFFC for every leaf, LineBreak or not.
const LEAF = "\ufffc";

const isBreak = (node) => node.type.hasRole(Node.Role.LineBreak);

// Prose textblocks whose LineBreaks are visual lines. Code blocks use LineBreak
// for source newlines. List items and table cells keep whole-block behavior.
function splittable(block) {
  if (!block?.parent) return false;
  const type = block.node.type;
  if (type !== Paragraph.type && type !== Heading) return false;
  return block.parent.node.type !== ListItem.type;
}

function breakRuns(block) {
  const runs = [];
  let pos = block.start;
  for (const child of block.node.content) {
    if (isBreak(child)) {
      const last = runs.at(-1);
      if (last && last.to === pos) last.to += child.length;
      else runs.push({ from: pos, to: pos + child.length });
    }
    pos += child.length;
  }
  return runs;
}

// Boundary of the visual line(s) holding `from`..`to`: the run of LineBreaks
// before the first line and the run after the last. Consecutive breaks are one
// boundary, so a blank line made with two breaks does not linger as an empty
// visual line on either side of the split.
function lineBoundaries(state, from, to) {
  const start = state.doc.resolve(from).textblockParent,
    end = state.doc.resolve(to).textblockParent;
  const range = from < to;
  const before = splittable(start)
    ? breakRuns(start)
        .filter((run) => run.to <= from || (range && run.from <= from && from < run.to))
        .at(-1)
    : null;
  const after = splittable(end)
    ? breakRuns(end).find((run) => run.from >= to || (range && run.from < to && to <= run.to))
    : null;
  if (before && after && before === after) return null;
  return {
    before: before && { ...before, block: start },
    after: after && { ...after, block: end },
  };
}

// Change specs that turn the visual lines covering `from`..`to` into their own
// textblock(s). Returns null when the range already starts and ends at
// textblock edges.
function lineSplits(state, from, to) {
  const bounds = lineBoundaries(state, from, to);
  if (!bounds) return null;
  const changes = [];
  for (const run of [bounds.before, bounds.after]) {
    if (!run) continue;
    const { block } = run;
    // A run at the textblock edge would leave an empty piece. Drop the breaks.
    if (run.from === block.start || run.to === block.end)
      changes.push({ from: run.from, to: run.to });
    else
      changes.push({ from: run.from, to: run.to, insert: [Plot.End, block.node.tag.split(false)] });
  }
  return changes.length ? changes : null;
}

function splitLines(state, from, to) {
  const specs = lineSplits(state, from, to);
  if (!specs) return null;
  const changes = ChangeSet.create(state.doc, specs);
  // A range edge on a replaced break stays on its own line: the start moves
  // past the boundary and the end stays before it. A caret goes with the line
  // its break belonged to.
  const map = (pos, side) => {
    if (from === to) side = specs.some((spec) => spec.to === pos) ? 1 : -1;
    const edge = specs.find((spec) => (side < 0 ? spec.to === pos : spec.from === pos));
    return changes.mapPos(edge ? (side < 0 ? edge.from : edge.to) : pos, side);
  };
  const { anchor, head } = state.selection;
  const forward = anchor <= head;
  const split = state.update({
    changes,
    selection: GardSelection.Text.create({
      anchor: map(anchor, forward ? 1 : -1),
      head: map(head, forward ? -1 : 1),
      marks: state.sel.activeMarks,
    }),
  });
  return { changes: split.changes, state: split.state };
}

// Run `command` on the state after the split and compose both change sets into
// one transaction, so undo restores the hard breaks along with the block type.
function afterSplit(split, spec, fallback = {}) {
  if (!spec || spec === true) return null;
  const tr = split.state.update(spec);
  if (!tr.docChanged) return null;
  return {
    changes: split.changes.compose(tr.changes),
    selection: tr.state.selection,
    scrollIntoView: true,
    userEvent: spec.userEvent ?? fallback.userEvent,
    annotations: fallback.annotations,
  };
}

// Toolbar and keyboard block commands go through Command.dispatch, which asks
// handlers first. When the selection covers part of a paragraph's lines, split
// those lines out and convert only them. Otherwise fall through to Wordgard.
const lineCommand = (command, applies = () => true) =>
  Command.handler(command, (editor, param) => {
    const { state } = editor;
    if (state.readOnly || !applies(state)) return false;
    const { from, to } = state.selection;
    const split = splitLines(state, from, to);
    if (!split) return false;
    return afterSplit(split, command({ state: split.state }, param)) ?? false;
  });

// List toggles inside a list item keep Wordgard's unwrap/retype behavior.
const outsideLists = (state) =>
  !state.sel.head.matchingParent((node) => node.type === ListItem.type);

export const lineBlockCommands = [
  lineCommand(setTextblockType),
  lineCommand(toggleList, outsideLists),
  lineCommand(toggleBlock, outsideLists),
];

// Paragraph-start Markdown shortcuts this editor installs. A typed prefix right
// after a LineBreak isolates that line and replays the same rule there.
export const blockInputRules = [
  heading.createOnHash,
  blockquote.createOnGT,
  taskListInputRule,
  bulletList.createOnDash,
  orderedList.createOnNumber,
];

function docMatch(state, map, match) {
  const result = [];
  for (let i = 0; i < match.length; i++) {
    if (match[i] == null) {
      result.push(null);
      continue;
    }
    const [from, to] = match.indices[i];
    result.push({
      from: state.doc.resolve(map.fromIndex(from)),
      to: state.doc.resolve(map.fromIndex(to)),
      text: match[i],
    });
  }
  return result;
}

// Mirrors Wordgard's applyInputRules for one textblock: same regexp, lookahead
// and match positions, so each rule sees what it would see at a paragraph start.
function applyBlockRule(state, rules) {
  const cursor = state.sel.head,
    block = cursor.textblockParent;
  if (!block) return null;
  const map = state.textblockMap(block),
    index = map.toIndex(cursor.pos);
  const before = map.text.slice(0, index),
    after = map.text.slice(index);
  for (const rule of rules) {
    const match = rule.expr.exec(before);
    if (!match || (rule.lookahead && !rule.lookahead.test(after))) continue;
    const spec = rule.apply(state, docMatch(state, map, match));
    if (spec) return spec;
  }
  return null;
}

// Every block prefix ends in the space just typed, so the rule's regexp only
// checks that. The line is the text after the last leaf before the caret; a
// backward scan keeps the per-keystroke cost linear in the line length.
export const lineStartInputRule = (rules = blockInputRules) =>
  InputRule.define({
    expr: / $/,
    apply(state, [typed]) {
      if (state.readOnly) return null;
      const block = typed.to.textblockParent;
      if (!block) return null;
      const map = state.textblockMap(block),
        text = map.text.slice(0, map.toIndex(typed.to.pos));
      const leaf = text.lastIndexOf(LEAF);
      if (leaf < 0) return null;
      const node = state.doc.resolve(map.fromIndex(leaf)).nodeAfter;
      if (!node || !isBreak(node)) return null;
      const line = text.slice(leaf + 1);
      if (!rules.some((rule) => rule.expr.test(line))) return null;
      const cursor = state.sel.head.pos;
      const split = splitLines(state, cursor, cursor);
      if (!split) return null;
      return afterSplit(split, applyBlockRule(split.state, rules), {
        userEvent: "input.markdown",
        annotations: history.isolate.of(true),
      });
    },
  });

// ```, optional spaces, and an optional language word. Returns the language
// ("" for none) or null when the line is not a fence.
function fenceLanguage(line) {
  if (!line.startsWith("```")) return null;
  const language = line.slice(3).trim();
  if (!language) return "";
  for (const character of language) if (character === "`" || /\s/.test(character)) return null;
  return language;
}

// Wordgard turns a paragraph holding only ``` into a code block on Enter. Do the
// same for a ``` line after a hard break.
export const lineCodeFence = Command.handler(enter, (editor) => {
  const { state } = editor;
  const { sel } = state;
  if (state.readOnly || !sel.selection.isCursor) return false;
  const block = sel.head.textblockParent;
  if (!splittable(block)) return false;
  const runs = breakRuns(block),
    head = sel.head.pos;
  const previous = runs.filter((run) => run.to <= head).at(-1);
  const next = runs.find((run) => run.from >= head);
  if (!previous || (next ? next.from !== head : head !== block.end)) return false;
  const map = state.textblockMap(block);
  const language = fenceLanguage(map.text.slice(map.toIndex(previous.to), map.toIndex(head)));
  if (language === null) return false;
  const split = splitLines(state, head, head);
  if (!split) return false;
  const fence = split.state.sel.head.textblockParent;
  if (!split.state.doc.schema.canContain(fence.parent.node.type, CodeBlock.type)) return false;
  let tag = CodeBlock;
  if (language && split.state.schema.has(CodeBlockLanguage))
    tag = tag.withMarks([CodeBlockLanguage.of(language)]);
  return (
    afterSplit(split, {
      changes: { from: fence.before, to: fence.end, insert: [tag] },
      selection: { anchor: fence.start },
      userEvent: "input.markdown",
    }) ?? false
  );
});

// The span a typed closing backtick ends, as textblock-map indices, or null.
// The opening backtick is the nearest one before the closing one, found by a
// backward scan rather than a regexp, so a long run without a closing backtick
// costs one linear pass. The content must hold non-whitespace and no leaf
// (hard break or image). An opening backtick that follows another backtick, or
// an odd number of backslashes, is literal.
function codeSpan(text) {
  const close = text.length - 1;
  if (text[close] !== "`") return null;
  const open = text.lastIndexOf("`", close - 1);
  if (open < 0 || text[open - 1] === "`") return null;
  const content = text.slice(open + 1, close);
  if (!/\S/.test(content) || content.includes(LEAF)) return null;
  let slashes = 0;
  while (text[open - 1 - slashes] === "\\") slashes++;
  if (slashes % 2) return null;
  return { open, close };
}

// `text` followed by a typed closing backtick becomes code-marked `text`. The
// text keeps its tokens: the rule deletes the two backticks and adds the mark,
// so undo puts the literal backticks back. Dollar signs get no rule: people
// type prices.
export const inlineCodeInputRule = InputRule.define({
  expr: /`$/,
  apply(state, [typed]) {
    if (state.readOnly) return null;
    const block = typed.to.textblockParent;
    if (!block) return null;
    const map = state.textblockMap(block);
    const span = codeSpan(map.text.slice(0, map.toIndex(typed.to.pos)));
    if (!span) return null;
    const open = map.fromIndex(span.open),
      start = map.fromIndex(span.open + 1),
      end = map.fromIndex(span.close),
      close = map.fromIndex(span.close + 1);
    let coded = false;
    state.doc.iterate(open, close, (node) => {
      if (node.isText && Code.isInSet(node.marks)) coded = true;
    });
    if (coded) return null;
    const changes = ChangeSet.create(state.doc, [
      { from: open, to: start },
      { from: start, to: end, add: Code },
      { from: end, to: close },
    ]);
    return {
      changes,
      // Text typed after the conversion is prose again.
      selection: GardSelection.Text.create({
        anchor: changes.mapPos(end, -1),
        marks: Code.removeFromSet(state.doc.resolve(end).marks()),
      }),
      annotations: history.isolate.of(true),
      userEvent: "input.markdown",
    };
  },
});

// A letter or digit. Emphasis delimiters next to one are part of a word, as
// in snake_case_name or 2*3*4, and never become a mark.
const WORD = /[\p{L}\p{N}]/u;

/**
 * The span a typed closing `delimiter` ends, as textblock-map indices of the
 * opening and closing delimiters, or null. Stricter than CommonMark, so typing
 * never formats text by surprise:
 * - The delimiters are exact runs: `**` never closes `*`, and `~~~` is not
 *   `~~`.
 * - The opening delimiter starts the line or follows a space or punctuation;
 *   the closing one is followed by the same (the rule's lookahead). Neither
 *   touches a letter or digit.
 * - The content is non-empty, starts and ends with a non-space, and holds no
 *   leaf (a hard break or image).
 * - A delimiter after an odd number of backslashes is literal.
 * The opening delimiter is the nearest one before the closing one, found by a
 * backward scan, so a long line without one costs one linear pass.
 */
export function delimitedSpan(text, delimiter) {
  const width = delimiter.length,
    char = delimiter[0];
  const close = text.length - width;
  if (close < 1 || !text.endsWith(delimiter) || text[close - 1] === char) return null;
  const escaped = (at) => {
    let slashes = 0;
    while (text[at - 1 - slashes] === "\\") slashes++;
    return slashes % 2 === 1;
  };
  if (escaped(close)) return null;
  for (let open = text.lastIndexOf(delimiter, close - width - 1); open >= 0; ) {
    // A longer run ending here: its last delimiter is not an opener.
    if (text[open + width] === char) return null;
    if (text[open - 1] === char) {
      open = text.lastIndexOf(delimiter, open - 1);
      continue;
    }
    const content = text.slice(open + width, close);
    if (
      !content ||
      /^\s|\s$/.test(content) ||
      content.includes(LEAF) ||
      escaped(open) ||
      (open > 0 && WORD.test(text[open - 1]))
    )
      return null;
    return { open, close };
  }
  return null;
}

// `delimiter`text`delimiter` becomes `mark`ed text when the closing
// delimiter is typed. Like the inline code rule, the text keeps its tokens:
// the rule deletes the delimiters and adds the mark, so undo restores them.
// Nothing happens inside code.
const delimitedMarkRule = (delimiter, mark) =>
  InputRule.define({
    expr: new RegExp(`${delimiter.replace(/[*~]/g, "\\$&")}$`),
    lookahead: /^(?![\p{L}\p{N}])/u,
    apply(state, [typed]) {
      if (state.readOnly) return null;
      const block = typed.to.textblockParent;
      if (!block) return null;
      const map = state.textblockMap(block);
      const span = delimitedSpan(map.text.slice(0, map.toIndex(typed.to.pos)), delimiter);
      if (!span) return null;
      const width = delimiter.length;
      const open = map.fromIndex(span.open),
        start = map.fromIndex(span.open + width),
        end = map.fromIndex(span.close),
        close = map.fromIndex(span.close + width);
      let coded = false;
      state.doc.iterate(open, close, (node) => {
        if (node.isText && Code.isInSet(node.marks)) coded = true;
      });
      if (coded) return null;
      const changes = ChangeSet.create(state.doc, [
        { from: open, to: start },
        { from: start, to: end, add: mark },
        { from: end, to: close },
      ]);
      return {
        changes,
        // Text typed after the conversion is not marked.
        selection: GardSelection.Text.create({
          anchor: changes.mapPos(end, -1),
          marks: mark.removeFromSet(state.doc.resolve(end).marks()),
        }),
        annotations: history.isolate.of(true),
        userEvent: "input.markdown",
      };
    },
  });

// Order matters: a typed `**` is tried as bold first. The single-delimiter
// rules then refuse it, because their closing delimiter must be an exact run.
export const markInputRules = [
  delimitedMarkRule("**", Strong),
  delimitedMarkRule("~~", Strikethrough),
  delimitedMarkRule("*", Emphasis),
  delimitedMarkRule("_", Emphasis),
];

export const strikethroughKey = KeyBinding.of({
  key: "Mod-Shift-x",
  run: (editor) => !editor.state.readOnly && Command.dispatch(editor, toggleMark, Strikethrough),
});

export const markdownShortcuts = () => [
  lineStartInputRule(),
  lineCodeFence,
  lineBlockCommands,
  inlineCodeInputRule,
  markInputRules,
  // `---` alone in a paragraph becomes a horizontal rule.
  horizontalRule.createOnDashes,
  strikethroughKey,
];
