// A bare link to another of this deployment's Pages or Projects draws as a
// chit: its glyph and the title this reader sees, or "Page unavailable".
// Page blocks (WordgardEditor.jsx) and comments (CommentRichText.jsx) both
// draw them.
//
// A bare link is a link mark whose text is exactly its href, with no title:
// what a pasted URL becomes (bare-links.mjs) and what an agent writes as an
// autolink, `<url>`. Only links shared/page-links.mjs linkedTarget accepts
// draw as chits; this Page's own links and links to the open Project stay
// plain, as everywhere else. Nothing is stored: the document keeps the URL,
// Markdown exports `<url>`, copy writes an ordinary link, and older clients
// show the URL.
//
// Wordgard 0.7.0 has no decoration that replaces a range with a widget, so a
// chit is two decorations over the unchanged text:
//
// - a range wrapper that hides the link's text (`wg-chit-source`, outside
//   the link's own <a>: its rank is below PagesLink's), and
// - a point widget at the link's start that draws the chit.
//
// Reveal on caret: in an editable block with focus, a caret inside the link
// or at either edge, or a selection with one end strictly inside it, shows
// the URL as ordinary editable text instead. Editing is then ordinary text
// editing, with no custom delete or IME handling. Wordgard can't measure a
// caret beside hidden text, which is why the edges reveal too. Only local
// transactions reveal: a peer's edit or a never-focused editor's default
// selection never opens a chit. Losing focus closes every chit.
//
// The widget reads the title from the tab's PageRefs (page-refs.mjs, given
// with chit-refs.mjs provideChitRefs). It asks for the target's meta when it connects and
// edits its own label when the answer arrives, so the block isn't redrawn.
// It is an <a> with the link's href and the Page or Project link class and
// data attribute (link-destination.mjs targetAttributes), so a click opens
// the link menu in an editable block, follows the link in a read-only one,
// and the hover card (page-link-card.mjs linkAt) treats it like any other
// Page or Project link.
//
// A labeled link, `[label](url)`, to another Page or Project keeps its label
// and draws as the link mark's own <a> (page-link-shape.mjs). When this
// reader can't open its target, the <a> carries `data-link-state=
// "unavailable"`, which CSS draws as a lock in place of the kind's glyph
// with the muted colour of an unavailable chit (wordgard.css), and an
// `aria-describedby` token naming one of two hidden elements outside every
// editor, "Page unavailable" or "Project unavailable" (describedBy). Both
// are attributes on the rendered <a>, never document content, so copy and
// Markdown keep the label and the link. A link that stops naming another
// Page or Project (its href edited) loses both.
//
// The labeledLinkMarks plugin draws them from the tab's PageRefs, and asks
// for a target's meta by the cause of each pass (labeledLinkAsks): when the
// editor draws its DOM or the tab's account changes, when a ref changes, and
// when the reader comes back to the tab (the window regains focus or the
// document turns visible). A ref change asks, while the tab is visible, only
// for a stale unavailable answer and for a failed recheck of one past its
// backoff. So an open tab doesn't poll its readable targets, a dropped or
// otherwise failing ref isn't asked again until a redraw or a return, and a
// wrong "unavailable" from a slow host heals while the reader looks: 15 s
// after it was answered, or, if that recheck fails, on the recheck's
// backoff, at most a minute apart. Writing a marker is a DOM change the
// editor observes, so each marker change is followed by one draw pass in
// that editor. A hover asks through the card.
import { filter, skip } from "rxjs";
import { Node } from "wordgard/doc";
import { Decoration, Widget, Wordgard } from "wordgard/editor";
import { GardState, Transaction } from "wordgard/state";
import { linkedTarget } from "../shared/page-links.mjs";
import {
  PAGE_LINK_CLASS,
  PROJECT_LINK_CLASS,
  linkDestination,
  targetAttributes,
} from "./link-destination.mjs";
import { pageTarget, projectTarget, refKey, settledOf } from "./page-refs.mjs";
import { PagesLink } from "./wordgard-model.mjs";
import { chitRefs as tabRefs } from "./chit-refs.mjs";

/** Measure the current visual anchor even after a peer's edits redraw the link. */
export function linkAnchorRect(editor, from) {
  const { node } = editor.domAtPos(from, 1);
  const element = node.nodeType === 1 ? node : node.parentElement;
  // A closed chit's visible widget sits just before its hidden link text.
  const chit = element?.closest(".wg-chit-source")?.previousElementSibling;
  return chit?.matches("a.wg-chit") ? chit.getBoundingClientRect() : editor.coordsAtPos(from);
}

/** Where chits are drawn: the address the links resolve against, and what
 * is open now, whose own links stay plain. */
const chitPlace = GardState.Facet.define({
  combine: (values) =>
    values[0] ?? {
      base: () => globalThis.location?.href,
      currentPageId: () => null,
      currentProjectId: () => null,
    },
});

/**
 * Every bare link in `doc` that names another Page or Project, as `{ from,
 * to, href, target }` in document order. `target` is linkedTarget's answer
 * for its href against `base`. A link's text may span several text nodes
 * (part of it bold); a link in a code block never counts.
 */
export function bareLinkRanges(doc, { base, currentPageId = null, currentProjectId = null }) {
  const ranges = [];
  let run = null;
  const close = () => {
    if (!run) return;
    const { link, from, to, text } = run;
    run = null;
    const { href, title } = link.value ?? {};
    if (title || typeof href !== "string" || text !== href) return;
    const target = linkedTarget(href, base, { currentPageId, currentProjectId });
    if (target) ranges.push({ from, to, href, target });
  };
  doc.iterate((node, pos) => {
    if (node.type.hasRole(Node.Role.Code)) return false;
    if (!node.isTextblock) return true;
    let at = pos + 1;
    for (const child of node.content) {
      const link = child.isText ? PagesLink.isInSet(child.marks) : null;
      if (link && run && (run.link === link || run.link.eq(link)) && run.to === at) {
        run.to += child.length;
        run.text += child.param;
      } else {
        close();
        if (link) run = { link, from: at, to: at + child.length, text: String(child.param) };
      }
      at += child.length;
    }
    close();
    return false;
  });
  close();
  return ranges;
}

/** The ranges `selection` reveals: an empty caret inside or at an edge, or
 * either end of a selection strictly inside. */
export function revealedBy(ranges, selection) {
  const { anchor, head } = selection;
  return ranges.filter(({ from, to }) =>
    anchor === head
      ? from <= head && head <= to
      : (from < anchor && anchor < to) || (from < head && head < to),
  );
}

const chitFocus = Transaction.Effect.define();

const scan = (doc, state) => {
  const place = state.facet(chitPlace);
  return bareLinkRanges(doc, {
    base: place.base(),
    currentPageId: place.currentPageId(),
    currentProjectId: place.currentProjectId(),
  });
};

/**
 * The chit field: `{ ranges, focused, revealed }`. `revealed` holds the
 * starts of the ranges shown as text. States and events:
 *
 * - a document change rescans `ranges`;
 * - a focus effect sets `focused`; losing it clears `revealed`;
 * - a local transaction that sets the selection, changes the document or
 *   moves focus recomputes `revealed` from the selection, when focused and
 *   editable;
 * - any other transaction (a peer's edit, a repaint) keeps the revealed
 *   ranges that still start where they did, mapped through the change, and
 *   never adds one.
 */
export const chitField = GardState.Field.define({
  create: (state) => ({ ranges: scan(state.doc, state), focused: false, revealed: [] }),
  update(value, tr) {
    let { ranges, focused, revealed } = value;
    const doc = tr.newDoc;
    if (tr.docChanged) ranges = scan(doc, tr.startState);
    let focusMoved = false;
    for (const effect of tr.effects)
      if (effect.is(chitFocus) && effect.value !== focused) {
        focused = effect.value;
        focusMoved = true;
      }
    const editable = !tr.startState.readOnly;
    if (!focused || !editable) revealed = [];
    else if (!tr.annotation(Transaction.remote) && (tr.selection || tr.docChanged || focusMoved))
      revealed = revealedBy(ranges, tr.newSelection).map((range) => range.from);
    else if (tr.docChanged)
      revealed = revealed
        .map((from) => tr.changes.mapPos(from, 1))
        .filter((from) => ranges.some((range) => range.from === from));
    if (
      ranges === value.ranges &&
      focused === value.focused &&
      revealed.length === value.revealed.length &&
      revealed.every((from, index) => from === value.revealed[index])
    )
      return value;
    return { ranges, focused, revealed };
  },
});

const hidden = Decoration.Range.wrapper("span", {
  attributes: { class: "wg-chit-source" },
  // Outside the link's own <a> (PagesLink's rank is 20), so its glyph
  // hides with its text.
  rank: 10,
});

/** The label a chit shows for its target's meta ref. */
export function chitLabel(kind, ref) {
  const settled = ref ? settledOf(ref) : null;
  if (settled?.name === "readable")
    return { text: settled.value.title || "Untitled", state: "readable" };
  if (settled?.name === "unavailable")
    return {
      text: kind === "project" ? "Project unavailable" : "Page unavailable",
      state: "unavailable",
    };
  if (ref?.name === "failed") return { text: null, state: "failed" };
  return { text: kind === "project" ? "Project" : "Page", state: "loading" };
}

/** Whether a chit should ask for `ref` again: never asked, stale, or failed
 * with its backoff passed. */
export function needsAsking(ref) {
  if (!ref || ref.name === "idle") return true;
  if (ref.name === "readable" || ref.name === "unavailable") return ref.stale;
  return ref.name === "failed" && ref.ready;
}

/**
 * Whether a labeled link asks for `ref` on a pass of `cause`:
 *
 * - "draw": the editor connected, redrew its DOM, or the tab's account
 *   changed. Asks a ref never asked (or dropped), and a failure past its
 *   backoff with no earlier answer.
 * - "change": a ref in the tab's store changed. Asks, only while the
 *   document is `visible`, a stale unavailable answer and a failed recheck
 *   of one past its backoff, so a lock drawn from a slow host's 404 heals
 *   while the reader looks. Never an idle ref (a 401 drops every ref, and
 *   asking again would loop), any other failure or a readable answer.
 * - "return": the reader came back to the tab. Asks a ref never asked, any
 *   stale answer and a failure past its backoff.
 *
 * A request in flight, a fresh answer or a failure still backing off asks
 * nothing, whatever the cause.
 */
export function labeledLinkAsks(ref, { cause, visible = true }) {
  if (!ref || ref.name === "idle") return cause === "draw" || cause === "return";
  if (ref.name === "readable") return ref.stale && cause === "return";
  if (ref.name === "unavailable")
    return ref.stale && (cause === "return" || (cause === "change" && visible));
  if (ref.name === "failed") {
    if (!ref.ready) return false;
    if (cause === "return") return true;
    if (cause === "draw") return ref.last === null;
    return visible && ref.last?.name === "unavailable";
  }
  return false;
}

/** The marker a labeled link to `target` draws for its meta ref: "Page
 * unavailable" or "Project unavailable" when the reader can't open it, or
 * null. `target` is a `{ kind }` (shared/page-links.mjs linkedTarget's
 * answer, or a PageRefs target); null, for a link that names no other Page
 * or Project, draws none. Loading and a failure with no settled answer draw
 * none either; a refresh keeps the answer it refreshes, as chitLabel does. */
export function unavailableLabel(target, ref) {
  if (!target) return null;
  const { text, state } = chitLabel(target.kind, ref);
  return state === "unavailable" ? text : null;
}

/** The ids of the hidden elements an unavailable link is described by. */
export const UNAVAILABLE_DESCRIPTION_IDS = Object.freeze({
  page: "pages-link-unavailable-page",
  project: "pages-link-unavailable-project",
});
const DESCRIPTION_TOKENS = new Set(Object.values(UNAVAILABLE_DESCRIPTION_IDS));

/** The id describing an unavailable link to a `kind`. The first call in a
 * document puts both descriptions at the end of its body, hidden and outside
 * every editor, so they never enter a document, a copy or an editor's DOM;
 * referenced hidden text still describes the link. */
function describedBy(kind, document) {
  const id = UNAVAILABLE_DESCRIPTION_IDS[kind];
  if (!document.getElementById(id)) {
    const holder = document.createElement("div");
    holder.hidden = true;
    for (const [each, text] of [
      ["page", "Page unavailable"],
      ["project", "Project unavailable"],
    ]) {
      const description = holder.appendChild(document.createElement("span"));
      description.id = UNAVAILABLE_DESCRIPTION_IDS[each];
      description.textContent = text;
    }
    document.body.append(holder);
  }
  return id;
}

/** Set `link`'s marker: unavailable, described by `descriptionId`, or none
 * when it's null. Other `aria-describedby` tokens (the hover card's) stay. */
function setMarker(link, descriptionId) {
  if (descriptionId) {
    if (link.dataset.linkState !== "unavailable") link.dataset.linkState = "unavailable";
  } else if (link.hasAttribute("data-link-state")) link.removeAttribute("data-link-state");
  const before = link.getAttribute("aria-describedby");
  const tokens = (before ?? "").split(/\s+/).filter((t) => t && !DESCRIPTION_TOKENS.has(t));
  if (descriptionId) tokens.unshift(descriptionId);
  const after = tokens.join(" ");
  if (after === (before ?? "")) return;
  if (after) link.setAttribute("aria-describedby", after);
  else link.removeAttribute("aria-describedby");
}

/** The labeled Page and Project links drawn in an editor: the link mark's own
 * <a>, not a chit's widget and not a chit's hidden source. */
const LABELED_LINKS = [
  `a.${PAGE_LINK_CLASS}[data-page-id]:not(.wg-chit)`,
  `a.${PROJECT_LINK_CLASS}[data-project-id]:not(.wg-chit)`,
].join(", ");

/** Draw each labeled link under `root` from `refs` as they are now, clear
 * the marker from any <a> that no longer is one, and ask once for each
 * target labeledLinkAsks names for this pass's `cause`. */
export function markLabeledLinks(root, refs, { cause, visible = true }) {
  const asks = new Map();
  const labeled = new Set();
  for (const link of root.querySelectorAll(LABELED_LINKS)) {
    if (link.closest(".wg-chit-source")) continue;
    labeled.add(link);
    const target = link.classList.contains(PROJECT_LINK_CLASS)
      ? projectTarget(link.dataset.projectId)
      : pageTarget(link.dataset.pageId);
    const ref = refs.ref(target, "meta");
    if (labeledLinkAsks(ref, { cause, visible })) asks.set(refKey(target, "meta"), target);
    const unavailable = unavailableLabel(target, ref) !== null;
    setMarker(link, unavailable ? describedBy(target.kind, link.ownerDocument) : null);
  }
  for (const link of root.querySelectorAll("a[data-link-state]"))
    if (!labeled.has(link)) setMarker(link, null);
  for (const target of asks.values()) refs.want(target, ["meta"]);
}

/** Whether the tab is visible now. */
const tabVisible = () => globalThis.document?.visibilityState !== "hidden";

/** The connected editors whose labeled links refresh when the reader comes
 * back to the tab. */
const markedEditors = new Set();

/** The reader came back to the tab: one "return" pass over every connected
 * editor. An ask moves its ref to requested, so a target linked from several
 * blocks is asked once, and a return that fires both focus and
 * visibilitychange asks once in all. */
function returnToMarkedEditors(event) {
  if (event.type === "visibilitychange" && !tabVisible()) return;
  const refs = tabRefs();
  if (!refs) return;
  for (const wg of markedEditors)
    markLabeledLinks(wg.contentDOM, refs, { cause: "return", visible: true });
}

/** One pair of listeners for the tab while any editor is connected, however
 * many blocks the Page has. */
function markEditor(wg) {
  markedEditors.add(wg);
  if (markedEditors.size !== 1) return;
  globalThis.document?.addEventListener("visibilitychange", returnToMarkedEditors);
  globalThis.window?.addEventListener("focus", returnToMarkedEditors);
}

function unmarkEditor(wg) {
  if (!markedEditors.delete(wg) || markedEditors.size !== 0) return;
  globalThis.document?.removeEventListener("visibilitychange", returnToMarkedEditors);
  globalThis.window?.removeEventListener("focus", returnToMarkedEditors);
}

/** Keeps an editor's labeled links drawn from the tab's PageRefs: a "draw"
 * pass when it connects, after every redraw of its DOM (which may have made
 * a link's <a> anew or changed its href, and follows any marker write the
 * editor observed), and when the tab signs in as another account; a
 * "change" pass on every ref change while connected; and a "return" pass
 * when the reader comes back to the tab. A 401 drops the refs but keeps the
 * account, so it draws nothing. */
const labeledLinkMarks = Wordgard.Plugin.define((wg) => {
  let subscription = null;
  const paint = (cause) => {
    const refs = tabRefs();
    if (refs) markLabeledLinks(wg.contentDOM, refs, { cause, visible: tabVisible() });
  };
  return {
    connect() {
      const refs = tabRefs();
      if (subscription || !refs) return;
      subscription = refs.store.select((state) => state.refs).subscribe(() => paint("change"));
      subscription.add(
        refs.store
          .select((state) => state.principal)
          .pipe(
            skip(1),
            filter((principal) => principal !== null),
          )
          .subscribe(() => paint("draw")),
      );
      markEditor(wg);
      paint("draw");
    },
    docUpdate: () => paint("draw"),
    disconnect() {
      subscription?.unsubscribe();
      subscription = null;
      unmarkEditor(wg);
    },
  };
});

const mounted = new WeakMap();
const chit = Widget.define({
  eq: (a, b) => a.href === b.href && a.kind === b.kind && a.id === b.id,
  render({ href, kind, id }, editor) {
    const dom = document.createElement("a");
    // An editable block or comment draft never follows its links on a plain
    // click: Page blocks open the link menu (WordgardEditor.jsx), and a
    // non-editable island would otherwise navigate where text links don't.
    dom.addEventListener("click", (event) => {
      if (editor.editable && !event.metaKey && !event.ctrlKey && event.button === 0)
        event.preventDefault();
    });
    const attributes = targetAttributes(
      kind === "project" ? { kind, projectId: id } : { kind, pageId: id },
    );
    for (const [name, value] of Object.entries(attributes)) dom.setAttribute(name, value);
    dom.classList.add("wg-chit");
    dom.setAttribute("href", linkDestination(href, globalThis.location?.href) ?? href);
    dom.setAttribute("target", "_blank");
    dom.setAttribute("rel", "noopener noreferrer");
    dom.setAttribute("contenteditable", "false");
    dom.dataset.href = href;
    const label = dom.appendChild(document.createElement("span"));
    label.className = "wg-chit-label";
    mounted.set(dom, { href, kind, id, label, unsubscribe: null });
    paint(dom);
    return dom;
  },
  connect(_value, dom) {
    const entry = mounted.get(dom);
    const chitRefs = tabRefs();
    if (!entry || entry.unsubscribe || !chitRefs) return;
    const target = entry.kind === "project" ? projectTarget(entry.id) : pageTarget(entry.id);
    const key = refKey(target, "meta");
    // Ask whenever the answer is missing (never asked, or dropped with the
    // account), stale, or a failure whose backoff has passed. Each of those
    // moves to requested, so asking can't loop. The first emission asks for
    // a chit that just connected.
    const subscription = chitRefs.store
      .select((state) => state.refs.get(key))
      .subscribe((ref) => {
        if (needsAsking(ref)) chitRefs.want(target, ["meta"]);
        paint(dom);
      });
    entry.unsubscribe = () => subscription.unsubscribe();
  },
  disconnect(_value, dom) {
    const entry = mounted.get(dom);
    entry?.unsubscribe?.();
    if (entry) entry.unsubscribe = null;
  },
  propagateEvent: () => false,
});

/** Draw `dom`'s label from the ref store as it is now. */
function paint(dom) {
  const entry = mounted.get(dom);
  if (!entry) return;
  const target = entry.kind === "project" ? projectTarget(entry.id) : pageTarget(entry.id);
  const ref = tabRefs()?.ref(target, "meta");
  const { text, state } = chitLabel(entry.kind, ref);
  // A failed lookup shows the URL, so the link still says where it goes.
  const shown = text ?? entry.href;
  if (entry.label.textContent !== shown) entry.label.textContent = shown;
  if (dom.dataset.state !== state) dom.dataset.state = state;
}

/** The field as drawn: a read-only block shows no URL, even in the
 * transaction that made it read-only. */
const shown = (state) => {
  const value = state.field(chitField);
  return state.readOnly && value.revealed.length ? { ...value, revealed: [] } : value;
};

/**
 * The chit extension, with the unavailable marker of labeled links
 * (labeledLinkMarks). `base()` is the address links resolve against (the
 * page's own, by default); `currentPageId()` and `currentProjectId()` name
 * what is open, whose own links stay plain links.
 */
export function pageChits({
  base = () => globalThis.location?.href,
  currentPageId = () => null,
  currentProjectId = () => null,
} = {}) {
  return [
    chitPlace.of({ base, currentPageId, currentProjectId }),
    chitField,
    labeledLinkMarks.extension,
    Wordgard.domEventObserver("focusin", (_event, wg) => {
      if (!wg.state.field(chitField).focused) wg.dispatch({ effects: chitFocus.of(true) });
    }),
    Wordgard.domEventObserver("focusout", (_event, wg) => {
      // Focus moving inside the editor (onto a widget's control) isn't leaving.
      queueMicrotask(() => {
        if (!wg.hasFocus && wg.state.field(chitField, false)?.focused)
          wg.dispatch({ effects: chitFocus.of(false) });
      });
    }),
    Decoration.Range.source.of((state) => {
      const { ranges, revealed } = shown(state);
      return Decoration.Range.set(
        ranges
          .filter((range) => !revealed.includes(range.from))
          .map((range) => [hidden, range.from, range.to]),
      );
    }),
    Decoration.Point.source.of((state) => {
      const { ranges, revealed } = shown(state);
      return Decoration.Point.set(
        ranges
          .filter((range) => !revealed.includes(range.from))
          .map((range) => [
            Decoration.Point.widget(
              chit.of({
                href: range.href,
                kind: range.target.kind,
                id: range.target.kind === "project" ? range.target.projectId : range.target.pageId,
              }),
              { side: -1 },
            ),
            range.from,
          ]),
      );
    }),
  ];
}
