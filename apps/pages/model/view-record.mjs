// Reading a stored view record (`pages.view`, model/view-doc.mjs): the
// rules a host write keeps, shared by the host, which writes views, and the
// viewer, which draws them. It imports no spec checker, so the viewer's
// editor chunk reads views without the chart code.
import { validSourceId } from "./sources-doc.mjs";
import {
  MAX_VIEW_DATA,
  MAX_VIEW_TITLE,
  VIEW_REVISION_PATTERN,
  validDataName,
} from "../shared/views.mjs";

export const STATUS = {
  invalid_view: 400,
  view_not_found: 404,
  stale_view: 409,
  unknown_source: 400,
  unknown_source_revision: 400,
};
const REVISION = new RegExp(VIEW_REVISION_PATTERN);

export function fail(code, message, details) {
  throw Object.assign(Error(message), { status: STATUS[code], code, ...(details && { details }) });
}
export const isMap = (value) => !!value && typeof value === "object" && !Array.isArray(value);
export const validRevision = (value) =>
  typeof value === "string" && REVISION.test(value) && Number.isSafeInteger(Number(value));
export const validTitle = (title) =>
  typeof title === "string" && !!title.trim() && title.trim().length <= MAX_VIEW_TITLE;
export const validTime = (value) =>
  typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));

/** A binding as a plain object, or undefined for one no host write stores. */
export function bindingOf(value) {
  if (!isMap(value) || !validSourceId(value.source_id)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "source_id" && key !== "revision")) return undefined;
  if (value.revision === undefined) return { source_id: value.source_id };
  return validRevision(value.revision)
    ? { source_id: value.source_id, revision: value.revision }
    : undefined;
}

/** A stored `data` map as plain bindings, or undefined when one is not a
 * binding a host write stores. */
function dataOf(data) {
  if (!isMap(data)) return undefined;
  const entries = Object.entries(data);
  if (entries.length > MAX_VIEW_DATA) return undefined;
  const out = [];
  for (const [name, value] of entries) {
    const binding = bindingOf(value);
    if (!binding || !validDataName(name)) return undefined;
    out.push([name, binding]);
  }
  // Built from entries, so no key can reach a prototype.
  return Object.fromEntries(out);
}

/** The view a document holds, as an agent reads it with its spec, or
 * undefined for a document with no view yet. A record no host write
 * produces is invalid_view. */
export function readView(doc, viewId) {
  if (!doc || doc.revision === undefined) return undefined;
  const producer = doc.producer;
  const data = dataOf(doc.data);
  let spec;
  try {
    spec = JSON.parse(String(doc.spec ?? ""));
  } catch {
    spec = undefined;
  }
  if (
    !validRevision(doc.revision) ||
    !validTitle(doc.title) ||
    typeof doc.media_type !== "string" ||
    !data ||
    !isMap(spec) ||
    !isMap(producer) ||
    typeof producer.kind !== "string" ||
    !validTime(producer.at) ||
    !isMap(producer.by)
  )
    fail("invalid_view", "Malformed view record");
  return {
    view_id: viewId,
    title: doc.title,
    media_type: doc.media_type,
    revision: doc.revision,
    data,
    spec,
    producer: {
      kind: producer.kind,
      at: producer.at,
      by: JSON.parse(JSON.stringify(producer.by)),
    },
  };
}
