// One of a Page's views as its host sees it: whether the view's document
// exists, and the steps that bring it into being. Each view id has its own
// state; the host keeps them in a map by view id and steps each with
// viewStep alone.
//
//   absent     `host/view/<view_id>` is not stored. Nothing is served; a
//              read lists no such view and insert_node can't name it
//   loading    the key is stored: the host serves the document, imports its
//              genesis (a no-op once stored) and replays its journal
//   storing    a first write: the host serves the document, imports its
//              fixed genesis and flushes it to the Page's storage
//   recording  the genesis is stored; the host puts `host/view/<view_id>`
//              and, for the Page's first view, the Page record with
//              `pages.view` in its `documentFormats`, in one put, then syncs
//   ready      the document exists and is served. View writes go through
//              the journal like every tool write
//
// The document is served from `storing` on, so a tab that is open when the
// view is created can sync it as soon as the Page body names it; nothing
// waits for a reconnect.
//
// Each persisted step is idempotent: the document id and genesis are fixed
// by the Page id and view id, so storing again stores nothing new, and the
// record put writes the same keys. A restart before `recording` finishes
// boots without the key: the state is `absent`, and the next write runs
// every step again. A restart after it boots into `loading`. Bytes a store
// left behind under a key that was never written are removed with the
// Page's plain storage on purge.
//
// Events:
//
//   boot      { recorded }: the host loads the Page's documents; `recorded`
//             says the view's key is stored
//   create    { recorded }: a view write needs the document
//   loaded, stored, recorded
//             the effect of that name finished
//   failed    the running effect threw; the next create starts over
//   drop      the Page's documents are gone (purge, tombstone)
//
// Effects: `load`, `store`, `record`. viewStep is the only transition; the
// host runs its effects after it, at the edge. The states, events and
// effects are those of the sources document (sources-lifecycle.mjs), one
// lifecycle per view.

import { SOURCES_ABSENT, sourcesStep } from "./sources-lifecycle.mjs";

export const VIEW_ABSENT = SOURCES_ABSENT;

/** `{ state, effects, rejected? }` for `event` in `current`. A rejected
 * event leaves the state as it was and runs nothing. */
export const viewStep = (current, event) => sourcesStep(current, event);
