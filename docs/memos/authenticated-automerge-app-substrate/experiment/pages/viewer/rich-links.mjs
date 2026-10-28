import { Plugin, PluginKey } from "prosemirror-state";
import { safeUrl } from "../model/richtext.mjs";

export const linkTargetKey = new PluginKey("pages-link-target");

// Opening is stricter than markup parsing: resolve relative links first and
// never let a generic document writer navigate to an executable scheme.
export function linkDestination(href, base) {
  if (!href || !safeUrl(href)) return null;
  try {
    const url = new URL(href, base);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function linkRangeAt(doc, position) {
  const point = doc.resolve(position);
  if (!point.parent.inlineContent) return null;
  const mark = [point.nodeAfter, point.nodeBefore]
    .map((node) => node?.marks.find((item) => item.type.name === "link"))
    .find(Boolean);
  if (!mark) return null;
  const runs = [];
  point.parent.forEach((node, offset) => {
    const from = point.start() + offset;
    if (mark.isInSet(node.marks)) {
      const previous = runs.at(-1);
      if (previous?.to === from) previous.to += node.nodeSize;
      else runs.push({ from, to: from + node.nodeSize, attrs: mark.attrs });
    }
  });
  return runs.find(({ from, to }) => from <= position && position <= to) ?? null;
}

// Popover targets belong to the editor, not to a stale React position. Map them
// through incoming changes and dismiss if the actual link was replaced.
export function observeLinkTarget(onChange) {
  return new Plugin({
    key: linkTargetKey,
    state: {
      init: () => null,
      apply(tr, previous) {
        const requested = tr.getMeta(linkTargetKey);
        if (requested !== undefined) return requested;
        if (!previous) return null;
        if (tr.selectionSet && !tr.docChanged) return null;
        if (!tr.docChanged) return previous;
        const from = tr.mapping.mapResult(previous.from, 1);
        const to = tr.mapping.mapResult(previous.to, -1);
        if ((from.deleted && to.deleted) || from.pos >= to.pos) return null;
        const current = linkRangeAt(tr.doc, from.pos);
        if (
          !current ||
          current.to < to.pos ||
          current.attrs.href !== previous.attrs.href ||
          current.attrs.title !== previous.attrs.title
        )
          return null;
        return current;
      },
    },
    view(view) {
      let previous;
      const publish = (state) => {
        const next = linkTargetKey.getState(state);
        if (previous !== next) {
          previous = next;
          onChange(next);
        }
      };
      publish(view.state);
      return { update: (next) => publish(next.state) };
    },
  });
}

export function changeTargetLink(state, dispatch, href, base) {
  const target = linkTargetKey.getState(state);
  if (!target) return false;
  if (href !== null && !linkDestination(href, base))
    throw Error("Enter a valid web, email, or telephone link.");
  const tr = state.tr.removeMark(target.from, target.to, state.schema.marks.link);
  if (href !== null)
    tr.addMark(target.from, target.to, state.schema.marks.link.create({ ...target.attrs, href }));
  dispatch?.(tr.setMeta(linkTargetKey, null));
  return true;
}
