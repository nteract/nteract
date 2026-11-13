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
import { Node } from "wordgard/doc";
import { Decoration, Widget, Wordgard } from "wordgard/editor";
import { GardState, Transaction } from "wordgard/state";
import { linkedTarget } from "../shared/page-links.mjs";
import { linkDestination, targetAttributes } from "./link-destination.mjs";
import { pageTarget, projectTarget, refKey, settledOf } from "./page-refs.mjs";
import { PagesLink } from "./wordgard-model.mjs";
import { chitRefs as tabRefs } from "./chit-refs.mjs";

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
 * The chit extension. `base()` is the address links resolve against (the
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
