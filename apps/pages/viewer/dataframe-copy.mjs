// Interprets dataframe-copy-machine.mjs for a Page block's editor.
//
// The pasted HTML, its insertion target and the AbortController stay here,
// keyed by token; the machine sees only tokens. The editor owns the
// document: it captures where the paste goes when it starts and lands it
// when asked.
import { Node, parse } from "wordgard/doc";
import { dataframeCopyMachine } from "./dataframe-copy-machine.mjs";
import { foreignDataframes } from "./wordgard-model.mjs";
import { clipboardCopyId, lookupCopy } from "./copy-registry.mjs";
import { resolveImageInsertion, selectionUnmoved } from "./image-upload.mjs";
import { GardSelection } from "wordgard/state";
import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

export const COPYING = "Copying the table's data from another Page…";
const TITLE_INSTEAD = "Pasted its title instead.";
/** Distinct tables one paste copies; the rest paste as titles. */
export const PASTE_TABLE_LIMIT = 8;
/** Copies one paste runs at a time. */
export const PASTE_COPY_CONCURRENCY = 2;
export const NOT_BROUGHT =
  "A table's data wasn't brought over, so it pasted as its title. Copy the table from its Page in this browser to bring its data.";

/** What the Page asks before a paste brings `count` tables' data from the
 * Page titled `title` in the copy record (never the clipboard's title). */
export const confirmQuestion = ({ count, title }) =>
  `Bring the data for ${count === 1 ? "1 table" : `${count} tables`} from ${
    title ? `"${title}"` : "another Page"
  } into this Page?`;
export const OVER_LIMIT = `Only ${PASTE_TABLE_LIMIT} tables' data copies in one paste; the rest pasted as titles.`;

/** Run `task` over `items`, PASTE_COPY_CONCURRENCY at a time, settling as
 * Promise.allSettled does. */
async function copyAll(items, task) {
  const results = Array.from({ length: items.length });
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const at = index++;
      try {
        results[at] = { status: "fulfilled", value: await task(items[at]) };
      } catch (reason) {
        results[at] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PASTE_COPY_CONCURRENCY, items.length) }, worker));
  return results;
}

/** Copy the dataset at `source` ({ pageId, assetId }) onto `pageId`, with
 * the reader's own session. Resolves to this Page's src for it. A refusal
 * keeps its HTTP status on the error. */
export async function copyPageDataset(pageId, source, signal, request = fetch) {
  const url = imageAssetUrl(pageId, source.assetId);
  const response = await request(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_page_id: source.pageId }),
    signal,
  });
  let result = null;
  try {
    result = await response.json();
  } catch {}
  if (!response.ok)
    throw Object.assign(
      Error(String(result?.error?.message ?? result?.error ?? `Copy failed (${response.status}).`)),
      { status: response.status },
    );
  if (
    !validAssetId(result?.asset_id) ||
    result.asset_id !== source.assetId ||
    result.url !== url ||
    result.mime_type !== PARQUET_MEDIA_TYPE
  )
    throw Error("The server returned an invalid dataset reference.");
  return url;
}

/**
 * Pasted HTML as a slice for `state`, read as the editor reads a paste: HTML
 * Wordgard copied keeps its open ends, other HTML collapses whitespace, and
 * `filters` (the editor's clipboardInputFilter facet) run after. The HTML is
 * parsed in `document`, a detached one, so nothing in it loads or runs.
 */
export function pastedSlice(state, html, { document, filters = [] }) {
  const container = document.createElement("div");
  container.innerHTML = html.replace(/^(\s*<meta [^>]*>)*/, "");
  const fromWordgard = container.querySelector("[wg-content=true]");
  let slice = parse.slice(state.schema, container, {
    collapseWhiteSpace: !fromWordgard,
    isOpen: fromWordgard ? (element) => element.getAttribute("wg-open") || null : undefined,
  });
  for (const filter of filters) slice = filter(slice, state);
  return slice;
}

/**
 * Whether a paste or drop reads the clipboard's HTML, as Wordgard decides:
 * its text wins in a code block and for paste-as-plain-text, and then a
 * held paste has nothing to do. `at` is the position the paste reads its
 * context from.
 */
export function readsPastedHTML(state, transfer, { at, plain = false }) {
  if (!transfer?.getData("text/html")) return false;
  const text =
    transfer.getData("text/plain") || transfer.getData("Text") || transfer.getData("text/uri-list");
  if (!text) return true;
  if (plain) return false;
  return !state.doc.resolve(at).parent.node.type.hasRole(Node.Role.Code);
}

/**
 * The change that lands a held paste: it replaces the range the person had
 * selected, `target.from` to `target.to` (two captured insertions,
 * image-upload.mjs), as Wordgard's own paste does. When an end no longer
 * resolves, the paste goes in at the end that does, the caret end first.
 * The editor dispatches it in `{ correct, local: true }`, as Wordgard's own
 * paste does.
 */
export function heldPasteChange(replica, target, map, insert) {
  const resolve = (end) => {
    try {
      return resolveImageInsertion(replica, end, map);
    } catch {
      return null;
    }
  };
  const to = resolve(target.to),
    from = target.from === target.to ? to : resolve(target.from);
  if (to === null && from === null)
    throw Error("The place you pasted changed before the table copied. Paste again.");
  if (to !== null && from !== null && from <= to) return { from, to, insert, fit: true };
  return { from: to ?? from, insert, fit: true };
}

/**
 * Where the caret goes once a held paste lands with `change`. If the
 * person's selection is where it was when they pasted, the caret goes after
 * the pasted content, as after Wordgard's own paste. If they typed or moved
 * it while the paste was held, the selection is theirs: undefined lets the
 * editor map it through the change.
 */
export function heldPasteSelection(replica, target, map, selection, change) {
  if (!selectionUnmoved(replica, target.to, map, selection)) return undefined;
  const end = change.to ?? change.from;
  return (cx, changes) => GardSelection.near(cx, changes.mapPos(end, 1), -1);
}

/**
 * Land a held paste: replace the captured range with `slice`, in the shape
 * Wordgard's own paste dispatches (corrected as a whole and kept narrow, so
 * an opened node doesn't swallow what follows), and put the caret after it
 * when the selection hasn't moved. `dispatch(spec)` applies the transaction
 * through the editor and returns whether the Page accepted it (the binding's
 * commit didn't refuse it). Throws when it was refused. A paste that changes
 * nothing, such as a table replacing an identical one, is accepted.
 */
export function landHeldPaste({ replica, target, map, slice, selection, dispatch }) {
  const change = heldPasteChange(replica, target, map, slice);
  const accepted = dispatch({
    changes: { correct: change, local: true },
    selection: heldPasteSelection(replica, target, map, selection, change),
    userEvent: "input.paste",
  });
  if (accepted !== true) throw Error("The paste didn't land. Paste it again.");
}

/** What the Page says when a table's data didn't copy. */
export function copyFailure(error) {
  const status = error?.status;
  if (status === 401 || status === 403)
    return `You don't have access to the Page this table came from. ${TITLE_INSTEAD}`;
  if (status === 404)
    return `This table's data is no longer on the Page it came from. ${TITLE_INSTEAD}`;
  if (status === undefined)
    return `Couldn't reach Pages to copy the table's data. ${TITLE_INSTEAD}`;
  const reason = String(error?.message ?? "").replace(/[.\s]+$/, "");
  return `Couldn't copy the table's data${reason ? `: ${reason}` : ""}. ${TITLE_INSTEAD}`.slice(
    0,
    240,
  );
}

/**
 * - pageId: this Page.
 * - copy(source, signal): resolves to this Page's src for `source`. Defaults
 *   to the host's copy route.
 * - insert(html, target, copied): land the paste at `target` with `copied`
 *   (source src → this Page's src) applied. Throws when it can't.
 * - onState(state): the machine state after each step.
 * - parser: a DOMParser, for reading the pasted HTML.
 * - lookup(id): this browser's copy record for a clipboard's copy id
 *   (copy-registry.mjs lookupCopy).
 */
export function createDataframeCopier({
  pageId,
  copy = (source, signal) => copyPageDataset(pageId, source, signal),
  insert,
  onState = () => {},
  parser,
  lookup = (id) => lookupCopy(id),
}) {
  let state = dataframeCopyMachine.initial,
    next = 0,
    alive = true;
  const jobs = new Map();
  const held = () => state.name === "confirming" || state.name === "copying";
  function step(event) {
    if (!alive) return { state, effects: [], rejected: "closed" };
    const result = dataframeCopyMachine.step(state, event);
    if (result.rejected) return result;
    state = result.state;
    // Report before the effects: an insert that fails steps again, and its
    // state is the one the Page should end on.
    onState(state);
    for (const effect of result.effects) run(effect);
    return result;
  }
  function run({ type, token }) {
    const job = jobs.get(token);
    if (type === "copy") {
      job.controller = new AbortController();
      const { signal } = job.controller;
      copyAll(job.sources, (source) =>
        signal.aborted ? Promise.reject(signal.reason) : copy(source, signal),
      ).then((results) => {
        if (signal.aborted) return;
        let failure;
        results.forEach((result, index) => {
          if (result.status === "fulfilled") job.copied.set(job.sources[index].src, result.value);
          else failure ??= result.reason;
        });
        // Every reason a table landed as its title, the request failure first.
        const message = [failure !== undefined && copyFailure(failure), job.skipped]
          .filter(Boolean)
          .join(" ");
        if (message) step({ type: "failed", token, message });
        else step({ type: "copied", token });
      });
    } else if (type === "abort") {
      job?.controller?.abort();
      jobs.delete(token);
    } else if (type === "insert") {
      jobs.delete(token);
      try {
        insert(job.html, job.target, job.copied);
      } catch (error) {
        step({
          type: "problem",
          message: String(error?.message || "The paste couldn't be added.").slice(0, 240),
        });
      }
    }
  }
  return {
    get state() {
      return state;
    },
    /** Paste or drop of `html` at `target()`: true when it holds tables
     * from another Page that this browser copied and the copy started, so
     * the editor leaves the event to it. False lets the editor paste it now,
     * those tables as titles; when the tables weren't this browser's own,
     * the Page says so. */
    accept(html, target) {
      if (!alive || held()) return false;
      const foreign = foreignDataframes(html, pageId, parser);
      if (!foreign.length) return false;
      // Only the id is read from the clipboard; the record says which Page
      // and assets this browser copied.
      const record = lookup(clipboardCopyId(html, parser));
      const own = foreign.filter(
        (source) => record?.page === source.pageId && record.assets.includes(source.assetId),
      );
      const sources = own.slice(0, PASTE_TABLE_LIMIT);
      const skipped =
        [own.length > sources.length && OVER_LIMIT, own.length < foreign.length && NOT_BROUGHT]
          .filter(Boolean)
          .join(" ") || null;
      if (!sources.length) {
        step({ type: "problem", message: skipped });
        return false;
      }
      let at;
      try {
        at = target();
      } catch {
        return false;
      }
      const token = ++next;
      jobs.set(token, {
        html,
        target: at,
        sources,
        skipped,
        title: record.title,
        copied: new Map(),
      });
      return !step({ type: "start", token }).rejected;
    },
    /** While confirming: what the Page asks, from the copy record. */
    get question() {
      const job = state.name === "confirming" && jobs.get(state.token);
      return job ? confirmQuestion({ count: job.sources.length, title: job.title }) : null;
    },
    /** Bring the data of the held paste `token` names: the copies start.
     * `token` is the one the question was shown for (state.token). */
    confirm(token) {
      return step({ type: "confirm", token });
    },
    /** Land the held paste `token` names now, its tables from other Pages
     * as titles. */
    decline(token) {
      return step({ type: "decline", token });
    },
    cancel() {
      return step({ type: "cancel" });
    },
    destroy() {
      if (held()) step({ type: "cancel" });
      alive = false;
    },
  };
}
