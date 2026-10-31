import { ChangeSet, Node, Plot } from "wordgard/doc";
import { GardSelection } from "wordgard/state";
import { InputRule } from "wordgard/editor";
import { Command, enter, setTextblockType, toggleBlock, toggleList } from "wordgard/command";
import { blockquote, bulletList, heading, orderedList } from "wordgard/schema";
import { history } from "wordgard/history";
import {
  Code,
  CodeBlock,
  CodeBlockLanguage,
  Heading,
  ListItem,
  Paragraph,
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

export const lineStartInputRule = (rules = blockInputRules) =>
  InputRule.define({
    expr: new RegExp(`${LEAF}([^${LEAF}]*)$`),
    apply(state, match) {
      if (state.readOnly) return null;
      const [leaf, line] = match;
      const node = leaf.from.nodeAfter;
      if (!node || !isBreak(node)) return null;
      if (!rules.some((rule) => rule.expr.test(line.text))) return null;
      const cursor = state.sel.head.pos;
      const split = splitLines(state, cursor, cursor);
      if (!split) return null;
      return afterSplit(split, applyBlockRule(split.state, rules), {
        userEvent: "input.markdown",
        annotations: history.isolate.of(true),
      });
    },
  });

// Wordgard turns a paragraph holding only ``` into a code block on Enter. Do the
// same for a ``` line after a hard break.
const FENCE = /^```\s*([^\s`]+\s*)?$/;
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
  const match = FENCE.exec(map.text.slice(map.toIndex(previous.to), map.toIndex(head)));
  if (!match) return false;
  const split = splitLines(state, head, head);
  if (!split) return false;
  const fence = split.state.sel.head.textblockParent;
  if (!split.state.doc.schema.canContain(fence.parent.node.type, CodeBlock.type)) return false;
  let tag = CodeBlock;
  if (match[1] && split.state.schema.has(CodeBlockLanguage))
    tag = tag.withMarks([CodeBlockLanguage.of(match[1].trim())]);
  return (
    afterSplit(split, {
      changes: { from: fence.before, to: fence.end, insert: [tag] },
      selection: { anchor: fence.start },
      userEvent: "input.markdown",
    }) ?? false
  );
});

// `text` followed by a typed closing backtick becomes code-marked `text`. The
// text keeps its tokens: the rule deletes the two backticks and adds the mark,
// so undo puts the literal backticks back. Dollar signs get no rule: people
// type prices.
export const inlineCodeInputRule = InputRule.define({
  expr: new RegExp(`(?:^|[^\`])(\`)([^\`${LEAF}]*[^\\s\`${LEAF}][^\`${LEAF}]*)(\`)$`),
  apply(state, match) {
    if (state.readOnly) return null;
    const [, open, text, close] = match;
    let coded = false;
    state.doc.iterate(open.from.pos, close.to.pos, (node) => {
      if (node.isText && Code.isInSet(node.marks)) coded = true;
    });
    if (coded) return null;
    const changes = ChangeSet.create(state.doc, [
      { from: open.from.pos, to: open.to.pos },
      { from: text.from.pos, to: text.to.pos, add: Code },
      { from: close.from.pos, to: close.to.pos },
    ]);
    const end = changes.mapPos(close.from.pos, -1);
    return {
      changes,
      // Text typed after the conversion is prose again.
      selection: GardSelection.Text.create({
        anchor: end,
        marks: Code.removeFromSet(state.doc.resolve(text.to.pos).marks()),
      }),
      annotations: history.isolate.of(true),
      userEvent: "input.markdown",
    };
  },
});

export const markdownShortcuts = () => [
  lineStartInputRule(),
  lineCodeFence,
  lineBlockCommands,
  inlineCodeInputRule,
];
