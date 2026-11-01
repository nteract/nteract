// Agent presence: where an API agent last wrote or is reading. It is derived
// from tool calls the host already authorized, held in memory, and broadcast as
// part of page-activity. It is never stored in the document or a receipt.
import * as A from "@automerge/automerge/slim";
import { isRich, textPath } from "./richtext.mjs";
import { textSegments, visibleNodeRange } from "./replace-match.mjs";

export const AGENT_PRESENCE = Object.freeze({
  // A targeted read shows for this long without another call.
  readingMs: 10_000,
  // A caret stays solid this long after the last write, then fades.
  activeMs: 15_000,
  // A faded caret disappears this long after the agent's last call.
  idleMs: 60_000,
  // Search reads with more hits than this say nothing about where it will write.
  maxHits: 3,
  maxTargets: 3,
  agents: 8,
  // The client chooses its MCP session id, so one account could mint caret
  // identities by varying it. Each account keeps at most this many per Page.
  sessionsPerPrincipal: 8,
});

/** Lifetime states. Hidden is the absence of a record. */
export const STATES = Object.freeze(["reading", "active", "idle"]);

/**
 * The one transition function. Events:
 * - `{ type: "read", at, targets }` from a targeted read with at least one target
 * - `{ type: "write", at, targets }` from a committed write batch
 * - `{ type: "tick", at }` from the host, before it reads or publishes the roster
 * Returns the next record, or null for hidden. Records are plain data.
 */
export function transition(record, event) {
  const { at } = event;
  if (event.type === "read") {
    if (!event.targets?.length) return record ? transition(record, { type: "tick", at }) : null;
    return {
      state: "reading",
      seq: (record?.seq ?? 0) + 1,
      targets: event.targets,
      since: at,
      lastCall: at,
    };
  }
  if (event.type === "write") {
    if (!event.targets?.length) return record ? { ...record, lastCall: at } : null;
    return {
      state: "active",
      seq: (record?.seq ?? 0) + 1,
      targets: event.targets,
      since: at,
      lastCall: at,
    };
  }
  if (event.type === "tick") {
    if (!record) return null;
    if (record.state === "reading")
      return at >= record.since + AGENT_PRESENCE.readingMs ? null : record;
    if (at >= record.lastCall + AGENT_PRESENCE.idleMs) return null;
    if (record.state === "active" && at >= record.lastCall + AGENT_PRESENCE.activeMs)
      return { ...record, state: "idle" };
    return record;
  }
  throw Error(`Unknown agent presence event: ${event.type}`);
}

/** When the record leaves the roster on its own. */
export function expiry(record) {
  if (!record) return Infinity;
  if (record.state === "reading") return record.since + AGENT_PRESENCE.readingMs;
  return record.lastCall + AGENT_PRESENCE.idleMs;
}

/** When a caret fades: the active record becomes idle. A reading marker never
 * fades, and an idle record already has. */
export function idleAt(record) {
  if (!record || record.state === "reading") return null;
  return record.lastCall + AGENT_PRESENCE.activeMs;
}

/** The state a published record shows at `at`, applying its own fade and
 * expiry. For readers that hold a snapshot and no host timer. */
export function stateAt(record, at) {
  if (!record || at >= expiry(record)) return null;
  const fades = idleAt(record);
  return fades !== null && at >= fades ? "idle" : record.state;
}

// Same endpoint affinity a browser uses for its own selection.
function textTarget(doc, kind, id, start, end) {
  const path = textPath(id);
  return {
    kind,
    block_id: id,
    start: A.getCursor(doc, path, start, "after"),
    end: A.getCursor(doc, path, end, end === start ? "after" : "before"),
  };
}

/**
 * The caret for a committed batch, from the edit trace of its operations. The
 * last operation wins; the edit underline already shows the others. Run inside
 * the change, so cursors name the characters this batch wrote.
 */
export function writeTargets(doc, trace) {
  const last = trace?.at(-1);
  if (!last || !Object.hasOwn(doc.blocks ?? {}, last.block_id)) return [];
  if (last.type === "block") return [{ kind: "block", block_id: last.block_id }];
  if (last.type !== "text" || !isRich(doc.blocks[last.block_id])) return [];
  return [textTarget(doc, "text", last.block_id, last.start, last.end)];
}

/**
 * Reading targets for a successful read_page. Whole-page and outline reads
 * return none. A search with 1–3 literal hits returns each hit; a section,
 * node range or block selection returns the passages it returned.
 */
export function readTargets(doc, args = {}, body = {}) {
  if (!args || body?.include_content === false || args.include_content === false) return [];
  const blocks = Array.isArray(body?.blocks) ? body.blocks : [];
  const ids = [...new Set(blocks.map((block) => block?.id))].filter(
    (id) => typeof id === "string" && Object.hasOwn(doc.blocks ?? {}, id) && isRich(doc.blocks[id]),
  );
  if (Array.isArray(args.search) && args.search.length) {
    const terms = args.search.filter((term) => typeof term === "string" && term.length);
    const hits = [];
    for (const id of ids)
      for (const segment of textSegments(doc.blocks[id]))
        for (const term of terms)
          for (
            let at = segment.text.indexOf(term);
            at >= 0;
            at = segment.text.indexOf(term, at + 1)
          ) {
            hits.push([id, segment.offset + at, segment.offset + at + term.length]);
            if (hits.length > AGENT_PRESENCE.maxHits) return [];
          }
    return hits.map(([id, start, end]) => textTarget(doc, "hit", id, start, end));
  }
  if (args.section === undefined && args.node_range === undefined && args.block_ids === undefined)
    return [];
  const targets = [];
  for (const block of blocks) {
    if (targets.length >= AGENT_PRESENCE.maxTargets) break;
    if (!ids.includes(block.id)) continue;
    const range = block.node_range;
    let start, end;
    if (range && Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to)) {
      if (range.to <= range.from) continue;
      start = visibleNodeRange(doc, block.id, range.from).start;
      end = visibleNodeRange(doc, block.id, range.to - 1).end;
    } else {
      start = 0;
      end = doc.blocks[block.id].richText.length;
    }
    // A node range starts on its native block marker, which an editor places at
    // the end of the previous paragraph. Start on the node's first character.
    while (start < end && doc.blocks[block.id].richText[start] === "\ufffc") start++;
    if (end > start) targets.push(textTarget(doc, "passage", block.id, start, end));
  }
  return targets;
}
