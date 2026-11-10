import * as A from "@automerge/automerge";
import { Refusal } from "../sync/host.mjs";

/** Whether `error`, or any error in its cause chain, is SyncHost's refusal
 * of a write past the Page's history bound. */
export function isHistoryCapacityError(error) {
  const seen = new Set();
  while (error && !seen.has(error)) {
    if (error instanceof Refusal && error.code === "history_capacity") return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/** Startup readiness targets the stored history that materializes. Stored
 * changes whose dependencies never became durable stay queued in the document,
 * and apply if a peer or a journaled intent supplies the dependencies. Readers
 * that already passed admission see this note, with a count only, so stranded
 * changes are not silently invisible. */
export function incompleteHistory(doc) {
  const missing = A.getMissingDeps(doc, []).length;
  if (!missing) return undefined;
  return {
    code: "page_history_incomplete",
    missing_dependencies: missing,
    message:
      "Some stored edits depend on history this Page does not hold. They will appear when a collaborator who has that history reconnects.",
  };
}

/** One structured line, with counts only, records that the Page started on an
 * incomplete history. Like admission logs it carries no Page ID, principal or
 * change hash. */
export function logIncompleteHistory(doc) {
  const incomplete = incompleteHistory(doc);
  if (!incomplete) return undefined;
  const record = {
    service: "nteract-pages-native",
    event: "page.history_incomplete",
    missing_dependencies: incomplete.missing_dependencies,
    timestamp: new Date().toISOString(),
  };
  console.warn(JSON.stringify(record));
  return record;
}
