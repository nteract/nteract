// Test support: a Page host's revision table over in-memory storage. The
// Worker never imports it.
import { headsFor, revisionsFor } from "./revisions.mjs";

/** `{ handles(requests), handle(doc, heads), heads(doc, handle, name) }`, the shape readTool and
 * readChangesTool take as `revisions`, backed by its own storage. */
export function revisionTable() {
  const values = new Map();
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (entries) => {
      for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value));
    },
    delete: async (key) => values.delete(key),
    list: async ({ prefix = "", limit = Infinity } = {}) =>
      new Map(
        [...values]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, limit),
      ),
    sync: async () => {},
  };
  const handles = (requests) => revisionsFor(storage, requests, Date.now());
  return {
    handles,
    handle: async (doc, heads) => (await handles([[doc, heads]]))[0],
    heads: (doc, handle, name) => headsFor(storage, doc, handle, name),
  };
}
