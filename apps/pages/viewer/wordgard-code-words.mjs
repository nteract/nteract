import { Command, deleteWord, moveByWord } from "wordgard/command";
import { Wordgard } from "wordgard/editor";
import { GardSelection } from "wordgard/state";
import { CodeBlock, CodeBlockLanguage } from "./wordgard-model.mjs";
import { languageFor } from "./code-highlight.mjs";
import { sourceOf } from "./wordgard-code-indent.mjs";

// Words in a code block are identifiers. Wordgard's own word is a run of
// letters and digits, which is right for prose and splits `pages_catalog_tags`
// at each underscore. Here a double-click, word motion and word deletion take
// the whole name. Outside a code block nothing in this file applies and the
// gesture or key stays Wordgard's.

// A word character is a letter, a digit, an underscore, or a character the
// block's language allows in its own identifiers.
const wordClass = (extra = "") => ({
  run: new RegExp(`[\\p{L}\\p{N}\\p{M}_${extra}]+`, "gu"),
  char: new RegExp(`[\\p{L}\\p{N}\\p{M}_${extra}]`, "u"),
});
const PLAIN = wordClass();
const WITH_DOLLAR = wordClass("$");
const WITH_HYPHEN = wordClass("\\-");
const CLASSES = new Map([
  ["JavaScript", WITH_DOLLAR],
  ["TypeScript", WITH_DOLLAR],
  ["CSS", WITH_HYPHEN],
]);
const classFor = (language) => CLASSES.get(languageFor(language)?.name) ?? PLAIN;
const JOINER = /[_$-]/;

const segmenter = Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

/** The words in a run of word characters, as offsets into the run. A run is
 * one word unless it holds text in a script that writes words without spaces,
 * such as Japanese in a comment. There the segmenter's boundaries apply, apart
 * from those beside a joining character: it splits `$name` and `font-size`. */
function wordsIn(run) {
  if (!segmenter) return [{ from: 0, to: run.length }];
  const words = [];
  let from = 0;
  for (const { index } of segmenter.segment(run)) {
    if (index === from || JOINER.test(run[index - 1]) || JOINER.test(run[index])) continue;
    words.push({ from, to: index });
    from = index;
  }
  words.push({ from, to: run.length });
  return words;
}

/** The line that holds `offset` and its words, all as source offsets. */
function lineWords(source, offset, language) {
  const from = source.lastIndexOf("\n", offset - 1) + 1;
  const end = source.indexOf("\n", offset);
  const to = end < 0 ? source.length : end;
  const words = [];
  for (const run of source.slice(from, to).matchAll(classFor(language).run))
    for (const word of wordsIn(run[0]))
      words.push({ from: from + run.index + word.from, to: from + run.index + word.to });
  return { from, to, words };
}

/** The word at `offset` in a code block's source, as `{ from, to }` offsets,
 * or null when no word touches it. `language` is the block's stored language.
 * Between two words, `bias` picks the one after (1) or before (-1). */
export function codeWordAt(source, offset, { bias = 1, language } = {}) {
  const touching = lineWords(source, offset, language).words.filter(
    (word) => word.from <= offset && offset <= word.to,
  );
  return (bias > 0 ? touching.at(-1) : touching[0]) ?? null;
}

/** Where word motion from `offset` lands: the end of the next word going
 * forward, the start of the previous one going back. Null when no word lies
 * that way. */
export function codeWordBoundary(source, offset, forward, language) {
  for (let at = offset; ; ) {
    const line = lineWords(source, at, language);
    const word = forward
      ? line.words.find((candidate) => candidate.to > offset)
      : line.words.findLast((candidate) => candidate.from < offset);
    if (word) return forward ? word.to : word.from;
    if (forward ? line.to === source.length : line.from === 0) return null;
    at = forward ? line.to + 1 : line.from - 1;
  }
}

/** What word deletion removes at a caret, as `{ from, to }` offsets: the
 * whitespace beside the caret, then one run of word characters or one run of
 * other characters. It stays inside the line. Null at the line's edge. */
export function codeWordDeletion(source, offset, forward, language) {
  const { char } = classFor(language);
  const { from, to } = lineWords(source, offset, language);
  const chars = Array.from(forward ? source.slice(offset, to) : source.slice(from, offset));
  if (!forward) chars.reverse();
  let size = 0;
  let run = null;
  for (const ch of chars) {
    const kind = /\s/.test(ch) ? null : char.test(ch) ? "word" : "other";
    if (run && kind !== run) break;
    run = kind;
    size += ch.length;
  }
  if (!size) return null;
  return forward ? { from: offset, to: offset + size } : { from: offset - size, to: offset };
}

const codeBlockAt = (state, pos) => {
  const block = state.doc.resolve(pos).textblockParent;
  return block?.node.type === CodeBlock.type ? block : null;
};

/** What a double-click at `pos` selects in a code block: the word there, or a
 * caret when there is none. Null outside a code block. */
export function codeWordSelection(state, pos, bias = 1) {
  const block = codeBlockAt(state, pos);
  if (!block) return null;
  const word = codeWordAt(sourceOf(block.node), pos - block.start, {
    bias,
    language: block.node.mark(CodeBlockLanguage),
  });
  return word
    ? GardSelection.undirectionalRange(block.start + word.from, block.start + word.to)
    : GardSelection.cursor(pos, bias);
}

/** The mouse selection for a double-click that starts in a code block, or null
 * for any other press. It is Wordgard's double-click gesture with the code
 * word in place of its own: a drag extends by whole words from the first one,
 * and Shift extends the selection that was there. A drag that leaves the code
 * block selects Wordgard's words from there on. */
export function codeWordMouseSelection(wg, event) {
  if (event.button !== 0 || event.detail !== 2) return null;
  const posAt = ({ clientX, clientY }) => wg.posAtCoords({ x: clientX, y: clientY });
  const wordAt = ({ pos, side }) =>
    codeWordSelection(wg.state, pos, side || 1) ?? wg.state.wordAt(pos, side || 1);
  let start = posAt(event);
  if (!codeWordSelection(wg.state, start.pos)) return null;
  let startSel = wg.state.selection;
  return {
    update(update) {
      if (!update.docChanged) return;
      start = { ...start, pos: update.changes.mapPos(start.pos) };
      startSel = startSel.map(update.changes, update.state);
    },
    get(current, extend) {
      const cur = posAt(current);
      const word = wordAt(cur);
      if (extend) {
        const anchor =
          !(startSel instanceof GardSelection.Text) || startSel.directional
            ? startSel.anchor
            : word.from < startSel.from
              ? startSel.to
              : startSel.from;
        const before = word.from < startSel.anchor;
        const side = word.from < word.to ? (before ? 1 : -1) : cur.side;
        return GardSelection.range(anchor, before ? word.from : word.to, side);
      }
      if (cur.pos === start.pos) return word;
      const first = wordAt(start);
      const from = Math.min(word.from, first.from);
      const to = Math.max(word.to, first.to);
      const [anchor, head] = first.from < word.from ? [from, to] : [to, from];
      return GardSelection.range(anchor, head, head === cur.pos ? cur.side : undefined);
    },
  };
}

/** Word motion with the head in a code block. It stops where Wordgard's does,
 * at the far end of the next word, and returns false when the block holds no
 * further word, so Wordgard moves the selection out of it. */
export function moveByCodeWord({ state }, { dir, extend }) {
  const { selection } = state;
  if (!(selection instanceof GardSelection.Text)) return false;
  const block = codeBlockAt(state, selection.head);
  if (!block) return false;
  const forward = (dir === "right") === state.textblockLTR(block.node);
  // A selection without a direction moves from the end that faces the motion.
  const [anchor, head] = selection.directional
    ? [selection.anchor, selection.head]
    : forward
      ? [selection.from, selection.to]
      : [selection.to, selection.from];
  if (head < block.start || head > block.end) return false;
  const offset = codeWordBoundary(
    sourceOf(block.node),
    head - block.start,
    forward,
    block.node.mark(CodeBlockLanguage),
  );
  if (offset === null) return false;
  const pos = block.start + offset;
  return {
    selection: extend ? GardSelection.range(anchor, pos) : GardSelection.cursor(pos),
    scrollIntoView: true,
    userEvent: "select",
  };
}

/** Word deletion at a caret in a code block. A selection, or a caret at the
 * line's edge, stays Wordgard's to delete. */
export function deleteCodeWord({ state }, dir) {
  const { selection } = state;
  if (state.readOnly || !selection.isCursor) return false;
  const block = codeBlockAt(state, selection.head);
  if (!block) return false;
  const forward = dir === "forward";
  const range = codeWordDeletion(
    sourceOf(block.node),
    selection.head - block.start,
    forward,
    block.node.mark(CodeBlockLanguage),
  );
  if (!range) return false;
  return {
    changes: { from: block.start + range.from, to: block.start + range.to },
    scrollIntoView: true,
    userEvent: forward ? "delete.forward" : "delete.backward",
  };
}

export const codeWords = [
  Wordgard.mouseSelectionStyle.of(codeWordMouseSelection),
  Command.handler(moveByWord, moveByCodeWord),
  Command.handler(deleteWord, deleteCodeWord),
];
