import { patchDocumentDelegate } from "./patch-document-delegate.mjs";
import { patchDocumentRecord } from "./patch-document-record.mjs";

// Source-hash-checked alterations to the pinned Repo 3 package. No wire or
// WASM changes.
export function patchUpstream(root) {
  return {
    documentDelegate: patchDocumentDelegate(root),
    documentRecord: patchDocumentRecord(root),
  };
}
