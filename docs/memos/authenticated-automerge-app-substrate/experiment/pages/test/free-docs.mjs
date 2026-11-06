// Automerge documents hold WebAssembly memory that garbage collection doesn't
// return during a long property search, and the module aborts once it runs
// out. Each property run frees the documents it made.
import * as A from "@automerge/automerge";

/** Run `body(keep)` and free every document passed to `keep` afterwards. Keep
 * each document's latest version: A.change and A.merge return a new version of
 * the same document, and the versions they replace share its memory. */
export function freeing(body) {
  const docs = new Set();
  try {
    return body((doc) => {
      docs.add(doc);
      return doc;
    });
  } finally {
    for (const doc of docs) A.free(doc);
  }
}
