// Interprets dataframe-copy-machine.mjs for a Page block's editor.
//
// The pasted HTML, its insertion target and the AbortController stay here,
// keyed by token; the machine sees only tokens. The editor owns the
// document: it captures where the paste goes when it starts and lands it
// when asked.
import { parse } from "wordgard/doc";
import { dataframeCopyMachine } from "./dataframe-copy-machine.mjs";
import { foreignDataframes } from "./wordgard-model.mjs";
import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

export const COPYING = "Copying the table's data from another Page…";
const TITLE_INSTEAD = "Pasted its title instead.";

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
 */
export function createDataframeCopier({
  pageId,
  copy = (source, signal) => copyPageDataset(pageId, source, signal),
  insert,
  onState = () => {},
  parser,
}) {
  let state = dataframeCopyMachine.initial,
    next = 0,
    alive = true;
  const jobs = new Map();
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
      Promise.allSettled(job.sources.map((source) => copy(source, signal))).then((results) => {
        if (signal.aborted) return;
        let failure;
        results.forEach((result, index) => {
          if (result.status === "fulfilled") job.copied.set(job.sources[index].src, result.value);
          else failure ??= result.reason;
        });
        if (failure === undefined) step({ type: "copied", token });
        else step({ type: "failed", token, message: copyFailure(failure) });
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
    /** Paste or drop of `html` at `target()`: true when it holds tables from
     * another Page and the copy started, so the editor leaves the event to
     * it. False lets the editor paste it now, those tables as titles. */
    accept(html, target) {
      if (!alive || state.name === "copying") return false;
      const sources = foreignDataframes(html, pageId, parser);
      if (!sources.length) return false;
      let at;
      try {
        at = target();
      } catch {
        return false;
      }
      const token = ++next;
      jobs.set(token, { html, target: at, sources, copied: new Map() });
      return !step({ type: "start", token }).rejected;
    },
    cancel() {
      return step({ type: "cancel" });
    },
    destroy() {
      if (state.name === "copying") step({ type: "cancel" });
      alive = false;
    },
  };
}
