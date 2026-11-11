import { blockChangeRefusal } from "../model/block-shape.mjs";
import { documentFeatures } from "../model/schema-features.mjs";
import { BLOCKING, commentAdmission } from "../sync/comments.mjs";
import { Refusal } from "../sync/host.mjs";

// The Page host's document type modules. The host serves a document by its
// `kind` and asks that kind's module every question whose answer depends on
// the document's type; it compares no kind itself. A Page's host serves one
// family: the Page document and its comments document.
//
// A module is host code. The browser bundle reads the type registry
// (model/document-types.mjs) and never imports this file.
//
// Members, and who asks:
//
//   type            the registered document type (model/document-types.mjs)
//   kind            the short name PlainSync registers a document under, and
//                   the name logs, revision storage and journal entries use
//   revisionLetter  the first letter of the document's revision handles
//                   (revisions.mjs)
//   revisionNoun    what a refused handle's message names (revisions.mjs)
//   revisionField   the receipt field that carries a write's revision handle
//                   (mutations.mjs)
//   writeAccess     the access a browser write needs, as the second argument
//                   to DocumentPolicy.account (PlainSync's role gate)
//   writeAction     the usage action an admitted browser write reports
//                   (usage-session.mjs BrowserWrites)
//   hostMessages    whether the document carries the Page's host messages to
//                   its readers: who wrote each admitted change
//                   (`actor-profiles`), and for a browser that joins it,
//                   presence, activity and the actor snapshot (PlainSync)
//   featureStamps(live)
//                   optional: the document's own stored schema-feature
//                   stamps a browser must support to write it. The Page's
//                   stamp gates every document of the Page and comes from
//                   PlainSync's `pageFeatures`, not from here
//   admit(conn, doc, live, fresh, preview, actorPrincipal, host)
//                   a browser's changes, after the schema gate and history
//                   cap: returns the preview to store or throws a Refusal
//                   (PlainSync's SyncHost `admit` policy)
//   refused(conn, doc, refusal, host)
//                   optional: what the document's type does after a browser
//                   frame to it is refused (PlainSync's SyncHost `refused`)
//
// `host` is PlainSync's state a module may act on: `isBlocked(principal)`
// and `block(principal, code)` over the Page's comment-blocked principals.

/** The Page document: rich text blocks, written by editors. */
export const PAGE_MODULE = Object.freeze({
  type: "pages.page",
  kind: "page",
  revisionLetter: "r",
  revisionNoun: "Page",
  revisionField: "revision",
  writeAccess: true,
  writeAction: "page.write",
  hostMessages: true,
  /**
   * The block shape the changes leave (model/block-shape.mjs). A refusal is
   * not fatal: an out-of-shape block is a client bug, so the socket stays
   * open and the principal is not blocked. Host writes produce valid blocks
   * and skip this check.
   */
  admit(_conn, _doc, _live, fresh, preview) {
    const refused = blockChangeRefusal(preview, fresh);
    if (refused) throw new Refusal(refused.code, refused.message);
    return preview;
  },
});

/** The Page's comments document: threads anchored to the Page, written by
 * commenters under the comment rules. */
export const COMMENTS_MODULE = Object.freeze({
  type: "pages.comments",
  kind: "comments",
  revisionLetter: "c",
  revisionNoun: "Page's comments",
  revisionField: "comment_revision",
  writeAccess: "comment",
  writeAction: "comment.write",
  hostMessages: false,
  /** The comments document's own schema stamp gates its writes too. */
  featureStamps: (live) => [documentFeatures(live)],
  /** The comment rules (sync/comments.mjs). A blocked principal's frames
   * are refused, and so is a change the rules forbid. */
  admit(conn, doc, live, fresh, preview, actorPrincipal, host) {
    return commentAdmission({ isBlocked: (blocked) => host.isBlocked(blocked.principal) })(
      conn,
      doc,
      live,
      fresh,
      preview,
      actorPrincipal,
    );
  },
  /** A refusal that means the principal authored a forbidden comment change
   * blocks its comment writes on this Page. */
  refused(conn, _doc, refusal, host) {
    if (BLOCKING.has(refusal.code)) host.block(conn.principal, refusal.code);
  },
});

/** The documents a Page's host serves, in registration order. */
export const PAGE_FAMILY_MODULES = Object.freeze([PAGE_MODULE, COMMENTS_MODULE]);

/** `kind → module` over `modules`. Two modules may not share a kind or a
 * revision letter, since both name a document in storage and on the agent
 * edge. */
export function modulesByKind(modules = PAGE_FAMILY_MODULES) {
  const byKind = new Map();
  const letters = new Set();
  for (const module of modules) {
    if (byKind.has(module.kind)) throw new TypeError(`Two modules share kind ${module.kind}`);
    if (letters.has(module.revisionLetter))
      throw new TypeError(`Two modules share revision letter ${module.revisionLetter}`);
    byKind.set(module.kind, module);
    letters.add(module.revisionLetter);
  }
  return byKind;
}

/** The Page family's modules by kind. */
export const PAGE_FAMILY = modulesByKind(PAGE_FAMILY_MODULES);
