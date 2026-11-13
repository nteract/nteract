// A Page's sources document as its host sees it: whether the document
// exists, and the steps that bring it into being. A Page with no sources has
// no sources document; the host creates it on the first source write.
//
//   absent     the Page's record doesn't name `pages.sources`. Nothing is
//              served; a read lists no sources
//   loading    the record names the type: the host serves the document,
//              imports its genesis (a no-op once stored) and replays its
//              journal
//   storing    a first write: the host serves the document, imports its
//              fixed genesis and flushes it to the Page's storage
//   recording  the genesis is stored; the host writes the Page record with
//              `pages.sources` in its `documentFormats`, then syncs
//   ready      the document exists and is served. Source writes go through
//              the journal like every tool write
//
// Each persisted step is idempotent: the document id and genesis are fixed
// by the Page id, so storing again stores nothing new, and the record put
// writes the same record. A restart before `recording` finishes boots with a
// record that doesn't name the type: the state is `absent`, and the next
// write runs every step again. A restart after it boots into `loading`. So
// no step needs recovery state of its own. Bytes a store left behind under a
// record that never named them are removed with the Page's plain storage on
// purge.
//
// Events:
//
//   boot      { recorded }: the host loads the Page's documents, from a record
//             that does or doesn't name the type
//   create    { recorded }: a source write needs the document, on a Page
//             whose record does or doesn't name the type
//   loaded, stored, recorded
//             the effect of that name finished
//   failed    the running effect threw; the next create starts over
//   drop      the Page's documents are gone (purge, tombstone)
//
// Effects: `load`, `store`, `record`. sourcesStep is the only transition; the
// host runs its effects after it, at the edge.

export const SOURCES_ABSENT = Object.freeze({ name: "absent" });
const state = (name) => Object.freeze({ name });

/** `{ state, effects, rejected? }` for `event` in `current`. A rejected
 * event leaves the state as it was and runs nothing. */
export function sourcesStep(current, event) {
  const to = (name, effects = []) => ({ state: state(name), effects });
  const reject = () => ({ state: current, effects: [], rejected: true });
  if (event.type === "drop") return to("absent");
  switch (current.name) {
    case "absent":
      if (event.type === "boot") return event.recorded ? to("loading", ["load"]) : to("absent");
      // A write to a Page whose record already names the type loads the
      // stored document and replays its journal; it never stores anew.
      if (event.type === "create")
        return event.recorded ? to("loading", ["load"]) : to("storing", ["store"]);
      return reject();
    case "loading":
      if (event.type === "loaded") return to("ready");
      // At boot a failed load fails the boot: the runtime replaces this
      // object (page-startup.mjs `failed`) and every request until then gets
      // the boot's error. A trashed Page whose document failed to load
      // retries loadDocument on its next request, and may land here; the
      // record still names the type, so the next write's `create` loads.
      if (event.type === "failed") return to("absent");
      return reject();
    case "storing":
      if (event.type === "stored") return to("recording", ["record"]);
      if (event.type === "failed") return to("absent");
      return reject();
    case "recording":
      if (event.type === "recorded") return to("ready");
      if (event.type === "failed") return to("absent");
      return reject();
    case "ready":
      // The document is open: a reload of the Page's documents or another
      // write needs nothing more.
      if (["boot", "create"].includes(event.type)) return to("ready");
      return reject();
    default:
      return reject();
  }
}
