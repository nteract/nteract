// One of a Page's views as its host sees it: whether the view's document
// exists, and the steps that bring it into being or give its slot back. Each
// view id has its own state; the host keeps them in a map by view id and
// steps each with viewStep alone.
//
//   absent     `host/view/<view_id>` is not stored. Nothing is served; a
//              read lists no such view and insert_node can't name it
//   loading    the key is stored: the host serves the document, imports its
//              genesis (a no-op once stored) and replays its journal
//   storing    a first write: the host serves the document, imports its
//              fixed genesis and flushes it to the Page's storage
//   recording  the genesis is stored; the host puts `host/view/<view_id>`,
//              then syncs. The key is the only record of a view: the Page
//              record never names `pages.view`, so a host that predates
//              views still opens the Page
//   ready      the document exists and is served. View writes go through
//              the journal like every tool write
//   releasing  a slot the boot that opened it found with no write: the host
//              stops serving the document and removes it, then deletes the
//              key and syncs. It stays here until the key is gone; a failed
//              release fails the boot, and the next boot (or, in a host
//              that is already running, the next write to this id) runs it
//              again. Nothing is created under the id meanwhile
//
// The document is served from `storing` on, so a tab that is open when the
// view is created can sync it as soon as the Page body names it; nothing
// waits for a reconnect. Reads and `/api/connect` list only a view with a
// revision, so a slot between `recording` and its first write, or one
// whose write failed, is never advertised. A running host never removes a
// served document: every refusal known in advance comes before the slot is
// taken, a slot whose write failed stays, and only boot releases, before
// any socket can hold the document.
//
// Each persisted step is idempotent: the document id and genesis are fixed
// by the Page id and view id, so storing again stores nothing new, and the
// record put writes the same key. A restart before `recording` finishes
// boots without the key: the state is `absent`, and the next write runs
// every step again. A restart after it boots into `loading`; a view that
// still has no revision once its journal is replayed is released, so a
// crash between the key and the journal entry leaves no slot taken. A key
// whose format this build doesn't write is never stepped at all.
//
// Events:
//
//   boot      { recorded }: the host loads the Page's documents; `recorded`
//             says the view's key is stored. In `releasing`, it runs the
//             release again
//   create    { recorded }: a view write needs the document
//   release   boot found the view with no revision once its journal was
//             replayed; in `releasing`, run the release again
//   loaded, stored, recorded, released
//             the effect of that name finished
//   failed    the running effect threw. A failed load, store or record
//             starts the next create over; a failed release stays
//             `releasing`
//   drop      the Page's documents are gone (purge, tombstone)
//
// Effects: `load`, `store`, `record`, `release`. viewStep is the only
// transition; the host runs its effects after it, at the edge, one event at
// a time per view.

export const VIEW_ABSENT = Object.freeze({ name: "absent" });
const state = (name) => Object.freeze({ name });

/** `{ state, effects, rejected? }` for `event` in `current`. A rejected
 * event leaves the state as it was and runs nothing. */
export function viewStep(current, event) {
  const to = (name, effects = []) => ({ state: state(name), effects });
  const reject = () => ({ state: current, effects: [], rejected: true });
  if (event.type === "drop") return to("absent");
  switch (current.name) {
    case "absent":
      if (event.type === "boot") return event.recorded ? to("loading", ["load"]) : to("absent");
      // A write to a view whose key is stored loads the stored document and
      // replays its journal; it never stores anew.
      if (event.type === "create")
        return event.recorded ? to("loading", ["load"]) : to("storing", ["store"]);
      return reject();
    case "loading":
      if (event.type === "loaded") return to("ready");
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
      if (["boot", "create"].includes(event.type)) return to("ready");
      if (event.type === "release") return to("releasing", ["release"]);
      return reject();
    case "releasing":
      if (event.type === "released") return to("absent");
      // The key may still be stored. Nothing is created under this id until
      // a boot or the next write runs the release again and it finishes.
      if (event.type === "failed") return to("releasing");
      if (["boot", "release"].includes(event.type)) return to("releasing", ["release"]);
      return reject();
    default:
      return reject();
  }
}
