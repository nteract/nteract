import { blockChangeRefusal } from "../model/block-shape.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { documentFeatures } from "../model/schema-features.mjs";
import { sourcesGenesis } from "../model/sources-doc.mjs";
import { viewGenesis } from "../model/view-doc.mjs";
import { SOURCES_LABEL, VIEW_LABEL } from "../shared/document-ids.mjs";
import { BLOCKING, commentAdmission } from "../sync/comments.mjs";
import { Refusal } from "../sync/host.mjs";
import { COMMENTS_LABEL } from "./comments-store.mjs";

// The Page host's document type modules. The host serves a document by its
// `kind` and asks that kind's module every question whose answer depends on
// the document's type; it compares no kind itself. A Page's host serves one
// family: the Page document, its comments document, once the Page has a
// source its sources document, and one document per view it holds.
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
//                   (revisions.mjs), or null for a document the agent edge
//                   never names by handle
//   revisionNoun    what a refused handle's message names (revisions.mjs)
//   revisionField   the receipt field that carries a write's revision handle
//                   (mutations.mjs), or null with a null revisionLetter
//   writeAccess     the access a browser write needs, as the second argument
//                   to DocumentPolicy.account (PlainSync's role gate), or
//                   null when no browser writes the document: only the host
//                   does, through the journal and `admitTrusted`
//   deniedWrites    what a browser frame that carries changes gets when its
//                   author lacks writeAccess: "strip" drops the changes and
//                   the rest of the frame stands; "refuse" refuses the frame
//                   with a non-fatal `request_rejected`, so nothing of it is
//                   stored and the principal is not blocked
//   writeAction     the usage action an admitted browser write reports
//                   (usage-session.mjs BrowserWrites), or null for none
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
//                   (PlainSync's SyncHost `admit` policy). Absent when
//                   writeAccess is null
//   derived         optional: `{ label, genesis(uuid) }` for a document the
//                   host derives from the Page: its UUID derived from the
//                   Page ID and `label` (shared/document-ids.mjs
//                   derivedDocUuid), its first change the fixed `genesis`,
//                   so creating it twice stores one document
//   keyed           optional: true for a type a Page holds several documents
//                   of, each derived from the Page ID and its own key (a
//                   view id). Its journal entries name the document as
//                   `<kind>:<key>` (keyedDoc)
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
  deniedWrites: "strip",
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
  deniedWrites: "strip",
  writeAction: "comment.write",
  hostMessages: false,
  derived: Object.freeze({ label: COMMENTS_LABEL, genesis: commentsGenesis }),
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

/** The Page's named sources (model/sources-doc.mjs): written by the host
 * alone, from edit_page set_source. A browser reads it; a browser frame that
 * changes it is refused, not stripped, so a client bug shows up as a
 * refusal and leaves nothing behind. */
export const SOURCES_MODULE = Object.freeze({
  type: "pages.sources",
  kind: "sources",
  revisionLetter: "s",
  revisionNoun: "Page's sources",
  revisionField: "sources_revision",
  writeAccess: null,
  deniedWrites: "refuse",
  writeAction: null,
  hostMessages: false,
  derived: Object.freeze({ label: SOURCES_LABEL, genesis: sourcesGenesis }),
});

/** One of the Page's views (model/view-doc.mjs): written by the host alone,
 * from edit_page set_view, and read-only to browsers like the sources
 * document. A view carries its own decimal `revision` in the document, which
 * set_view checks and its receipt returns as `view_revision`, so the agent
 * edge names no handle for it and it has no revision letter. */
export const VIEW_MODULE = Object.freeze({
  type: "pages.view",
  kind: "view",
  revisionLetter: null,
  revisionNoun: "view",
  revisionField: null,
  writeAccess: null,
  deniedWrites: "refuse",
  writeAction: null,
  hostMessages: false,
  keyed: true,
  derived: Object.freeze({ label: VIEW_LABEL, genesis: viewGenesis }),
});

/** The documents a Page's host serves, in registration order. */
export const PAGE_FAMILY_MODULES = Object.freeze([
  PAGE_MODULE,
  COMMENTS_MODULE,
  SOURCES_MODULE,
  VIEW_MODULE,
]);

/** `kind → module` over `modules`. Two modules may not share a kind or a
 * revision letter, since both name a document in storage and on the agent
 * edge. */
export function modulesByKind(modules = PAGE_FAMILY_MODULES) {
  const byKind = new Map();
  const letters = new Set();
  for (const module of modules) {
    if (byKind.has(module.kind)) throw new TypeError(`Two modules share kind ${module.kind}`);
    if (module.revisionLetter !== null && letters.has(module.revisionLetter))
      throw new TypeError(`Two modules share revision letter ${module.revisionLetter}`);
    byKind.set(module.kind, module);
    if (module.revisionLetter !== null) letters.add(module.revisionLetter);
  }
  return byKind;
}

/** The Page family's modules by kind. */
export const PAGE_FAMILY = modulesByKind(PAGE_FAMILY_MODULES);

/** The name a journal entry gives one document of a keyed module:
 * `view:<view_id>`. */
export const keyedDoc = (module, key) => `${module.kind}:${key}`;

/** The module of the document a journal entry names: a kind, or a keyed
 * module's `<kind>:<key>`. Undefined for neither. */
export function documentModule(doc, family = PAGE_FAMILY) {
  if (typeof doc !== "string") return undefined;
  const split = doc.indexOf(":");
  if (split === -1) return family.get(doc);
  const module = family.get(doc.slice(0, split));
  return module?.keyed ? module : undefined;
}
