// A view document (`pages.view`) as the viewer reads it, outside React. Its
// input is one view replica (host-doc-replica.mjs): the replica's state says
// whether there is a document at all, and the document's value says what it
// draws. The output is one projection:
//
// - `{ status: "pending" }`: the replica is still looking the document up.
// - `{ status: "ready", view }`: `view` is `{ view_id, title, media_type,
//   spec, data, revision }`, with `spec` parsed and `data` the bindings.
// - `{ status: "unavailable", reason, sentence }`: nothing to draw, and the
//   one sentence the embed shows. `reason` is `missing` (no such view on this
//   Page, as for a chart pasted from another Page), `unreadable` (a host or
//   media type this build doesn't read), `malformed` (a document no host write
//   produces), `failed` (lookups kept failing), `closed` (the replica was
//   retired) or `limit` (the Page already shows MAX_VIEWS views,
//   view-replicas.mjs).
//
// A host-written view is read with the host's own reader: a record no host
// write produces makes the whole view malformed, rather than drawing part
// of it.
import { combineLatest, distinctUntilChanged, map } from "rxjs";
import { readView } from "../model/view-record.mjs";
import { VIEW_MEDIA_TYPES } from "../shared/views.mjs";

/** The media type a view holds in v1. */
export const VIEW_MEDIA_TYPE = VIEW_MEDIA_TYPES[0];

export const VIEW_SENTENCES = Object.freeze({
  missing: "This chart isn't on this Page.",
  unreadable: "This build can't show this chart.",
  malformed: "This chart's view can't be read.",
  failed: "This chart couldn't be loaded.",
  closed: "This chart isn't available.",
  limit: "A Page shows at most 10 charts.",
});

const PENDING = Object.freeze({ status: "pending" });
const unavailable = (reason, sentence = VIEW_SENTENCES[reason]) =>
  Object.freeze({ status: "unavailable", reason, sentence });

/**
 * The projection of view `viewId`'s document value `doc` (the replica's
 * `doc$`), read with the host's own reader (model/view-record.mjs readView): a
 * record no host write produces is malformed, and a document that holds no
 * view yet (stored, with no revision) reads as not on this Page until its
 * first write lands.
 */
export function projectView(viewId, doc) {
  if (doc === undefined) return PENDING;
  let view;
  try {
    view = readView(doc, viewId);
  } catch {
    return unavailable("malformed");
  }
  if (!view) return unavailable("missing");
  const { title, media_type, spec, data, revision } = view;
  if (!VIEW_MEDIA_TYPES.includes(media_type))
    return unavailable("unreadable", `This build can't show ${media_type.slice(0, 80)}.`);
  const bindings = Object.entries(data).map(([name, binding]) => [name, Object.freeze(binding)]);
  return Object.freeze({
    status: "ready",
    view: Object.freeze({
      view_id: viewId,
      title,
      media_type,
      spec,
      data: Object.freeze(Object.fromEntries(bindings)),
      revision,
      // The spec as stored, for comparing two projections cheaply.
      specText: String(doc.spec),
    }),
  });
}

/** The projection for a replica in `state` (host-doc-open-machine.mjs) whose
 * document value is `doc`. */
export function viewProjection(viewId, state, doc) {
  switch (state?.name) {
    case "ready":
      return projectView(viewId, doc);
    case "absent":
      return unavailable("missing");
    case "unserved":
    case "unreadable":
      return unavailable("unreadable");
    case "failed":
      return unavailable("failed");
    case "retired":
      return unavailable("closed");
  }
  return PENDING;
}

/** Two projections draw the same thing. A rewritten view always carries a
 * new revision; the title, data and spec text are compared as well, so a
 * document no host write produces still redraws when it changes. */
export function sameProjection(a, b) {
  if (a === b) return true;
  if (a.status !== b.status) return false;
  if (a.status === "unavailable") return a.reason === b.reason && a.sentence === b.sentence;
  if (a.status !== "ready") return true;
  const x = a.view;
  const y = b.view;
  return (
    x.view_id === y.view_id &&
    x.revision === y.revision &&
    x.title === y.title &&
    x.specText === y.specText &&
    JSON.stringify(x.data) === JSON.stringify(y.data)
  );
}

/**
 * The view `viewId` as one stream over its replica (`state$`, a Store, and
 * `doc$`): the current projection on subscribe, then each change that
 * draws differently. A change to the document that leaves the view the same
 * emits nothing.
 */
export function viewStore(viewId, replica) {
  return combineLatest([replica.state$.state$, replica.doc$]).pipe(
    map(([state, doc]) => viewProjection(viewId, state, doc)),
    distinctUntilChanged(sameProjection),
  );
}
