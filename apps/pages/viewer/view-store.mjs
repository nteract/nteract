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
// A host-written view is checked again here: a field the contract doesn't
// allow makes the whole view malformed, rather than drawing part of it.
import { combineLatest, distinctUntilChanged, map } from "rxjs";
import { validSourceId } from "../model/sources-doc.mjs";

/** The one media type a view holds in v1. */
export const VIEW_MEDIA_TYPE = "application/vnd.vegalite.v6+json";
/** The longest view title. */
export const VIEW_TITLE_MAX = 200;

const VIEW_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const RESERVED = new Set(["constructor", "prototype", "__proto__"]);
/** A view id as the contract allows it. */
export const validViewId = (id) => typeof id === "string" && VIEW_ID.test(id) && !RESERVED.has(id);

const REVISION = /^[1-9][0-9]{0,15}$/;
const validRevision = (value) => typeof value === "string" && REVISION.test(value);

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

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** One binding as stored: `{ source_id }` or `{ source_id, revision }`, as a
 * frozen copy, or null for anything else. */
function readBinding(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (!validSourceId(value.source_id)) return null;
  if (keys.length === 1) return Object.freeze({ source_id: value.source_id });
  if (keys.length === 2 && validRevision(value.revision))
    return Object.freeze({ source_id: value.source_id, revision: value.revision });
  return null;
}

/**
 * The projection of view `viewId`'s document value `doc` (the replica's
 * `doc$`). A document is always read whole: any field outside the contract
 * makes it malformed.
 */
export function projectView(viewId, doc) {
  if (doc === undefined) return PENDING;
  if (!isPlainObject(doc)) return unavailable("malformed");
  const { title, media_type, spec, data, revision } = doc;
  if (typeof media_type !== "string") return unavailable("malformed");
  if (media_type !== VIEW_MEDIA_TYPE)
    return unavailable("unreadable", `This build can't show ${media_type.slice(0, 80)}.`);
  if (typeof title !== "string" || !title || title.length > VIEW_TITLE_MAX)
    return unavailable("malformed");
  if (!validRevision(revision) || !isPlainObject(data)) return unavailable("malformed");
  // Automerge text reads as a string.
  const text = typeof spec === "string" ? spec : spec?.toString?.();
  if (typeof text !== "string") return unavailable("malformed");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unavailable("malformed");
  }
  if (!isPlainObject(parsed)) return unavailable("malformed");
  // Data names are the writer's: a name like `__proto__` stays an own key.
  const bindings = Object.create(null);
  for (const name of Object.keys(data).sort()) {
    const binding = readBinding(data[name]);
    if (!binding) return unavailable("malformed");
    bindings[name] = binding;
  }
  return Object.freeze({
    status: "ready",
    view: Object.freeze({
      view_id: viewId,
      title,
      media_type,
      spec: parsed,
      data: Object.freeze(bindings),
      revision,
      // The spec as stored, for comparing two projections cheaply.
      specText: text,
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
