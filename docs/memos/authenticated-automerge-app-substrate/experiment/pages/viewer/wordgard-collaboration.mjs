import * as A from "@automerge/automerge/slim";
import { Decoration } from "wordgard/editor";
import { selectionContext } from "../model/comments.mjs";
import { activityIdentity, progressPassages } from "./activity.mjs";
import { monotonicNow } from "./monotonic.mjs";

const pathFor = (id) => ["blocks", id, "richText"];
const presenceTTL = 30000;
const illuminationTTL = 2000;
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
  // The replica's monotonic clock, which stamps its peers' `at`.
  now = () => replica.now?.() ?? monotonicNow(),
}) {
  const visiblePeers = new Map();
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

  function observeChange(event) {
    if (event.remote === false || !event.actors?.length || !event.changes) return;
    const doc = event.nativeAfter;
    const source = doc?.blocks?.[id]?.richText;
    const object = textObject(doc, id);
    const map = event.after?.map ?? getCurrent()?.map;
    if (typeof source !== "string" || !object || !map) return;
    event.changes.iterChangedRanges((_oldFrom, _oldTo, newFrom, newTo) => {
      const from = mapped(map.wgToAm, newFrom);
      const to = mapped(map.wgToAm, newTo);
      if (from === null || to === null || from >= to || to > source.length) return;
      const text = source.slice(from, to);
      if (!text.replaceAll("\ufffc", "").trim()) return;
      // Anchor the final character, not the next character after the range:
      // deleting the received text must not illuminate unrelated surviving text.
      const last = to - Array.from(text).at(-1).length;
      illumination.push({
        object,
        first: A.getCursor(doc, pathFor(id), from, "after"),
        last: A.getCursor(doc, pathFor(id), last, "before"),
        actors: [...new Set(event.actors)],
        until: now() + illuminationTTL,
      });
    });
    illumination = illumination.filter((mark) => mark.until > now()).slice(-128);
  }

  function ranges() {
    const entries = [];
    const add = (from, to, attributes) => {
      if (from < to) entries.push([Decoration.Range.wrapper("span", { attributes }), from, to]);
    };
    for (const peer of peers())
      add(peer.from, peer.to, { class: "peer-selection", title: peer.displayName });
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
    for (const range of commentRanges()) {
      if (range.state !== "open" && range.id !== activeId()) continue;
      add(range.from, range.to, {
        class: "comment-passage" + (range.id === activeId() ? " comment-passage-active" : ""),
        "data-comment-thread": range.id,
      });
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
        add(from, to, {
          class: "remote-edit",
          title: `Edited by ${[...new Set(mark.actors.map((actor) => replica.actorDisplayName(actor)))].join(", ")}`,
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
    return peers().map(({ session, displayName, caret }) => ({
      session,
      displayName,
      position: caret,
    }));
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
    observeChange,
    revealThread,
    commentAtPosition,
    destroy() {
      visiblePeers.clear();
      illumination = [];
    },
  };
}
