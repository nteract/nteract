import * as A from "@automerge/automerge/slim";
import { Decoration } from "wordgard/editor";
import { selectionContext } from "../model/comments.mjs";
import { resolvePeerSelection } from "../model/presence.mjs";
import { activityIdentity, agentKey, newestProgressFirst, progressPassages } from "./activity.mjs";
import { monotonicNow } from "./monotonic.mjs";
import { presenceColor } from "./presence-color.mjs";

const pathFor = (id) => ["blocks", id, "richText"];
const presenceTTL = 30000;
const illuminationTTL = 2000;
// How long a write's selection fills the changed text before it collapses to
// a caret at its end: select, then change.
export const SELECT_BEAT_MS = 600;
const textObject = (doc, id) => doc?.blocks?.[id] && A.getObjectId(doc.blocks[id], "richText");
const mapped = (mapping, position) => {
  const value = mapping?.[position];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

function selectionRange(replica, id, editor, map) {
  const source = replica.doc?.blocks?.[id]?.richText;
  const selection = editor?.state.selection;
  if (typeof source !== "string" || !selection) return null;
  const anchor = mapped(map?.wgToAm, selection.anchor);
  const head = mapped(map?.wgToAm, selection.head);
  if (anchor === null || head === null || anchor > source.length || head > source.length)
    return null;
  return { from: Math.min(anchor, head), to: Math.max(anchor, head), backward: anchor > head };
}

export function publishWordgardSelection(replica, id, editor, map) {
  if (!editor?.hasFocus) return;
  const range = selectionRange(replica, id, editor, map);
  if (!range) return;
  const path = pathFor(id);
  replica.publishPresence({
    block_id: id,
    start: A.getCursor(replica.doc, path, range.from, "after"),
    end: A.getCursor(replica.doc, path, range.to, range.to === range.from ? "after" : "before"),
    backward: range.backward,
    heads: A.getHeads(replica.doc),
  });
}

// Keep the existing tool/comment contract: captureCommentDraft immediately
// turns this occurrence into native cursors before a composer can lose focus.
export function wordgardCommentSelection(replica, id, editor, map) {
  const range = selectionRange(replica, id, editor, map);
  if (!range || range.from === range.to) return null;
  const source = replica.doc.blocks[id].richText;
  const text = source.slice(range.from, range.to);
  if (!text.replaceAll("\ufffc", "").trim()) return null;
  let occurrence = 0;
  let index = -1;
  while ((index = source.indexOf(text, index + 1)) >= 0 && index <= range.from) occurrence++;
  return { text, occurrence };
}

export function wordgardCommentRanges(doc, id, map, threads) {
  if (!textObject(doc, id)) return [];
  return threads.flatMap((thread) => {
    const context = selectionContext(doc, thread.target);
    if (context?.status !== "attached" || context.start.blockId !== id) return [];
    const from = mapped(map?.amToWg, context.start.offsetUtf16);
    const to = mapped(map?.amToWg, context.end.offsetUtf16);
    return from !== null && to !== null && from < to
      ? [{ id: thread.id, from, to, state: thread.state }]
      : [];
  });
}

// Ephemeral presentation only. PageSession owns the document, transport,
// authenticated names, and permissions. The caller owns subscriptions/timers.
export function createWordgardCollaboration({
  replica,
  id,
  getEditor,
  getCurrent,
  getThreads = () => [],
  getTarget = () => null,
  getDraft = () => null,
  // The replica's monotonic clock, which stamps its peers' `at`.
  now = () => replica.now?.() ?? monotonicNow(),
}) {
  const visiblePeers = new Map();
  // When each agent write (agent id and seq) first resolved in this block.
  const beats = new Map();
  let illumination = [];
  const activeId = () => {
    const target = getTarget();
    return typeof target === "string" ? target : (target?.id ?? target?.thread_id);
  };
  const commentRanges = () =>
    wordgardCommentRanges(replica.doc, id, getCurrent()?.map, getThreads());

  function peers() {
    const doc = replica.doc;
    const object = textObject(doc, id);
    const current = getCurrent();
    if (!object || !current) {
      visiblePeers.clear();
      return [];
    }
    const resolved = [];
    const present = new Set();
    for (const [session, latest] of replica.peers ?? []) {
      present.add(session);
      if (latest.value?.block_id !== id || now() - latest.at > presenceTTL) {
        visiblePeers.delete(session);
        continue;
      }
      const resolve = (peer) => {
        if (!peer || peer.object !== object || now() - peer.at > presenceTTL) return null;
        try {
          if (!A.hasHeads(doc, peer.value.heads)) return null;
          const from = mapped(
            current.map.amToWg,
            A.getCursorPosition(doc, pathFor(id), peer.value.start),
          );
          const to = mapped(
            current.map.amToWg,
            A.getCursorPosition(doc, pathFor(id), peer.value.end),
          );
          if (from === null || to === null || from > current.doc.length || to > current.doc.length)
            return null;
          return {
            session,
            from: Math.min(from, to),
            to: Math.max(from, to),
            caret: peer.value.backward ? from : to,
            displayName: latest.displayName || "Collaborator",
            color: presenceColor(latest.profile?.principal ?? session, latest.profile?.driver),
          };
        } catch {
          return null;
        }
      };
      const candidate = { ...latest, object };
      const value = resolve(candidate);
      if (value) {
        visiblePeers.set(session, candidate);
        resolved.push(value);
      } else {
        // A new cursor can outrun its document change. Keep the last causal
        // cursor for this session/object until the change arrives or it expires.
        const previous = resolve(visiblePeers.get(session));
        if (previous) resolved.push(previous);
        else visiblePeers.delete(session);
      }
    }
    for (const session of visiblePeers.keys())
      if (!present.has(session)) visiblePeers.delete(session);
    return resolved;
  }

  // Agent presence resolved for this block. Text targets carry editor
  // positions; a write's fill shows only during its select beat.
  function agentMarks() {
    const doc = replica.doc;
    const map = getCurrent()?.map;
    if (!textObject(doc, id) || !map) return [];
    const at = now();
    const marks = [];
    const live = new Set();
    // The newest live progress message per agent rides on its caret.
    const messages = new Map();
    for (const progress of replica.agentProgress?.values() ?? []) {
      if (progress.until <= at) continue;
      const key = agentKey(progress);
      if (!messages.has(key) || newestProgressFirst(progress, messages.get(key)) < 0)
        messages.set(key, progress);
    }
    for (const agent of replica.agentPresence?.values() ?? []) {
      if (agent.until <= at) continue;
      const identity = activityIdentity(agent);
      const message = messages.get(agentKey(agent))?.message ?? "";
      const base = {
        session: `agent:${agent.agent_id}`,
        // "Kyle's Kilo · release agent": account, harness, session label.
        displayName: [`${identity.name}'s ${identity.driver}`, agent.agent]
          .filter(Boolean)
          .join(" · "),
        tag: "agent",
        title: agent.agent ? `${identity.label} (${agent.agent})` : identity.label,
        color: presenceColor(agent.principal, agent.driver, agent.agent),
        idle: agent.state === "idle",
        message,
      };
      for (const target of agent.targets) {
        if (target.block_id !== id) continue;
        if (target.kind === "block") {
          marks.push({ ...base, type: "dot" });
          continue;
        }
        const range = resolvePeerSelection(doc, target);
        if (range?.status !== "attached") continue;
        const from = mapped(map.amToWg, range.start_utf16);
        const to = mapped(map.amToWg, range.end_utf16);
        if (from === null || to === null) continue;
        if (target.kind === "text") {
          const key = `${agent.agent_id}:${agent.seq}`;
          live.add(key);
          if (!beats.has(key)) beats.set(key, at);
          const beat = agent.state === "active" && from < to ? beats.get(key) + SELECT_BEAT_MS : 0;
          marks.push({ ...base, type: "caret", from, to, position: to, fillUntil: beat });
        } else marks.push({ ...base, type: target.kind, from, to });
      }
    }
    for (const key of beats.keys()) if (!live.has(key)) beats.delete(key);
    return marks;
  }

  // The change that wrote the character a cursor names: cursors read
  // "counter@actor", and each change covers ops startOp..maxOp of its actor.
  // `byActor` holds each actor's changes sorted by startOp. One actor's
  // changes never overlap in op counters, so a binary search finds the change
  // covering a counter in O(log changes), even for a large batch from the
  // single actor the host uses for API agents.
  function writtenBy(cursor, byActor) {
    const at = typeof cursor === "string" ? cursor.indexOf("@") : -1;
    if (at < 1) return null;
    const counter = Number(cursor.slice(0, at));
    const changes = byActor.get(cursor.slice(at + 1));
    if (!changes || !Number.isSafeInteger(counter)) return null;
    let low = 0,
      high = changes.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const change = changes[middle];
      if (counter < change.startOp) high = middle - 1;
      else if (counter > change.maxOp) low = middle + 1;
      else return change.hash;
    }
    return null;
  }

  function observeChange(event) {
    if (event.remote === false || !event.actors?.length || !event.changes) return;
    const doc = event.nativeAfter;
    const source = doc?.blocks?.[id]?.richText;
    const object = textObject(doc, id);
    const map = event.after?.map ?? getCurrent()?.map;
    if (typeof source !== "string" || !object || !map) return;
    const byActor = new Map();
    for (const change of event.changeOps ?? []) {
      if (!byActor.has(change.actor)) byActor.set(change.actor, []);
      byActor.get(change.actor).push(change);
    }
    for (const changes of byActor.values()) changes.sort((a, b) => a.startOp - b.startOp);
    event.changes.iterChangedRanges((_oldFrom, _oldTo, newFrom, newTo) => {
      const from = mapped(map.wgToAm, newFrom);
      const to = mapped(map.wgToAm, newTo);
      if (from === null || to === null || from >= to || to > source.length) return;
      const text = source.slice(from, to);
      if (!text.replaceAll("\ufffc", "").trim()) return;
      // One mark per run of characters written by the same change, so adjacent
      // inserts from two authors in one batch keep their own colors. Characters
      // no change in this batch wrote (formatting on old text) have no known
      // author: they get a mark with no hash, drawn in the neutral color.
      const path = pathFor(id);
      let start = from,
        owner;
      for (let at = from; at <= to; ) {
        const point = at < to ? source.codePointAt(at) : undefined;
        const width = point > 0xffff ? 2 : 1;
        const next = at < to ? writtenBy(A.getCursor(doc, path, at, "after"), byActor) : Symbol();
        if (at === from) owner = next;
        else if (next !== owner) {
          const run = source.slice(start, at);
          if (run.replaceAll("\ufffc", "").trim()) {
            // Anchor the final character, not the next character after the run:
            // deleting the received text must not illuminate surviving text.
            const last = at - Array.from(run).at(-1).length;
            illumination.push({
              object,
              first: A.getCursor(doc, path, start, "after"),
              last: A.getCursor(doc, path, last, "before"),
              actors: [...new Set(event.actors)],
              hash: owner,
              until: now() + illuminationTTL,
            });
          }
          start = at;
          owner = next;
        }
        if (at === to) break;
        at += width;
      }
    });
    illumination = illumination.filter((mark) => mark.until > now()).slice(-128);
  }

  function ranges() {
    const entries = [];
    const add = (from, to, attributes) => {
      if (from < to) entries.push([Decoration.Range.wrapper("span", { attributes }), from, to]);
    };
    for (const peer of peers())
      add(peer.from, peer.to, {
        class: "peer-selection",
        title: peer.displayName,
        style: `--peer-color: ${peer.color.background}`,
      });
    for (const mark of agentMarks()) {
      const filled = mark.type === "hit" || (mark.type === "caret" && mark.fillUntil > now());
      if (filled)
        add(mark.from, mark.to, {
          class: "agent-selection",
          title: mark.type === "hit" ? `${mark.title} is reading` : mark.title,
          style: `--peer-color: ${mark.color.background}`,
        });
    }
    for (const passage of progressPassages(replica, now())) {
      if (passage.block_id !== id) continue;
      const map = getCurrent()?.map;
      const from = mapped(map?.amToWg, passage.start_utf16);
      const to = mapped(map?.amToWg, passage.end_utf16);
      if (from === null || to === null) continue;
      add(from, to, {
        class: "agent-progress-passage",
        title: `${activityIdentity(passage.progress).label}: ${passage.progress.message}`,
        "data-progress-id": passage.progress.progress_id,
        "data-progress-target": String(passage.index),
      });
    }
    const created = getTarget()?.source === "created";
    for (const range of commentRanges()) {
      if (range.state !== "open" && range.id !== activeId()) continue;
      const active = range.id === activeId();
      add(range.from, range.to, {
        class:
          "comment-passage" +
          (active ? " comment-passage-active" : "") +
          (active && created ? " comment-passage-created" : ""),
        "data-comment-thread": range.id,
      });
    }
    // The open composer's passage stays marked while focus is in the popover,
    // which also anchors the popover to these elements.
    const draft = getDraft();
    if (draft?.target?.kind === "selection") {
      const [range] = wordgardCommentRanges(replica.doc, id, getCurrent()?.map, [
        { id: "draft", state: "open", target: draft.target },
      ]);
      if (range)
        add(range.from, range.to, { class: "comment-draft-passage", "data-comment-draft": "" });
    }
    const doc = replica.doc;
    const object = textObject(doc, id);
    const current = getCurrent();
    illumination = illumination.filter((mark) => mark.until > now() && mark.object === object);
    for (const mark of illumination) {
      try {
        const path = pathFor(id);
        const last = A.getCursorPosition(doc, path, mark.last);
        if (A.getCursor(doc, path, last, "before") !== mark.last) continue;
        const point = doc.blocks[id].richText.codePointAt(last);
        if (point === undefined) continue;
        const from = mapped(current?.map.amToWg, A.getCursorPosition(doc, path, mark.first));
        const to = mapped(current?.map.amToWg, last + (point > 0xffff ? 2 : 1));
        if (from === null || to === null) continue;
        // The underline takes the editor's own caret color when we know who
        // they are; otherwise the neutral edit color.
        // Only a host-attested change identity names an author. Anything
        // else, including the host's shared actor, stays neutral.
        const who = mark.hash ? replica.changeIdentity?.(mark.hash) : null;
        add(from, to, {
          class: "remote-edit",
          // An unattested range never borrows a name: the host's actor would
          // name whichever agent edited last.
          title: who
            ? `Edited by ${[who.displayName, who.driver, who.agent].filter(Boolean).join(" · ")}`
            : "Edited by a collaborator",
          ...(who?.principal && {
            style: `--peer-color: ${presenceColor(who.principal, who.driver, who.agent).background}`,
          }),
        });
      } catch {
        // The native text object or selected characters no longer exist.
      }
    }
    entries.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    return Decoration.Range.set(entries);
  }

  // Render these in the host's out-of-flow overlay. Wordgard owns selections
  // and marks; transient cursor DOM must not be copied by its range renderer.
  function carets() {
    const entries = peers().map(({ session, displayName, caret, color }) => ({
      type: "caret",
      session,
      displayName,
      color,
      position: caret,
    }));
    const reading = new Set();
    for (const mark of agentMarks()) {
      const { session, displayName, tag, color, idle, message } = mark;
      const title = message ? `${mark.title}: ${message}` : mark.title;
      if (mark.type === "caret")
        entries.push({
          type: "caret",
          session,
          displayName,
          tag,
          title,
          color,
          idle,
          message,
          position: mark.position,
        });
      else if (mark.type === "dot")
        entries.push({ type: "dot", session, displayName, tag, title, color, idle, message });
      else {
        // One reading label per agent, on its first passage or hit.
        const first = !reading.has(session);
        reading.add(session);
        entries.push({
          type: "bar",
          session: `${session}:${mark.from}`,
          label: first ? `${displayName} is reading` : "",
          title,
          color,
          from: mark.from,
          to: mark.to,
        });
      }
    }
    return entries;
  }

  /** Milliseconds until a select beat ends, so the host can repaint it into
   * a caret. A delay, not a time: the host's timers don't share this clock. */
  function nextRepaint() {
    const at = now();
    const ends = agentMarks()
      .map((mark) => mark.fillUntil ?? 0)
      .filter((until) => until > at);
    return ends.length ? Math.min(...ends) - at : null;
  }

  function commentAtPosition(position) {
    const matching = commentRanges()
      .filter((range) => range.state === "open" && range.from <= position && position < range.to)
      .sort((a, b) => a.to - a.from - (b.to - b.from));
    return matching.find((range) => range.id === activeId())?.id ?? matching[0]?.id ?? null;
  }

  function revealThread(thread, { scroll = true, focus = false } = {}) {
    const editor = getEditor();
    if (!editor || editor.composing) return false;
    const threadId = typeof thread === "string" ? thread : thread?.id;
    const range = commentRanges().find((range) => range.id === threadId);
    if (!range) return false;
    if (scroll) {
      const { node } = editor.domAtPos(range.from);
      const element = node.nodeType === 1 ? node : node.parentElement;
      element?.scrollIntoView?.({ block: "center", inline: "nearest" });
    }
    // Revealing a passage normally keeps the reply draft and mobile keyboard
    // alone. Focus is opt-in, and this never replaces the current selection.
    if (focus && replica.canWrite !== false) editor.focus();
    return true;
  }

  return {
    ranges,
    carets,
    nextRepaint,
    observeChange,
    revealThread,
    commentAtPosition,
    destroy() {
      visiblePeers.clear();
      beats.clear();
      illumination = [];
    },
  };
}
