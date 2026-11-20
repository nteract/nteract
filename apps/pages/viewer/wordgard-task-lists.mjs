import { Elt, Node, Plot } from "wordgard/doc";
import { Correction } from "wordgard/state";
import { Decoration, InputRule, KeyBinding, Widget } from "wordgard/editor";
import { toggleList, listIsActive } from "wordgard/command";
import { history } from "wordgard/history";
import {
  ListItem,
  BulletList,
  OrderedList,
  Paragraph,
  TaskList,
  TaskChecked,
} from "./wordgard-model.mjs";

// Enter intentionally drops the checked mark. Normalize only local transactions
// so new items start unchecked and converting to prose/bullets removes task state.
export const normalizeTaskItems = Correction.onContent(
  [TaskList, BulletList, OrderedList],
  (position) => {
    const changes = [];
    let at = position.start;
    for (const item of position.node.content) {
      const checked = TaskChecked.isInSet(item.tag.marks);
      if (position.node.type === TaskList.type && !checked)
        changes.push({ from: at, add: TaskChecked.of(false) });
      else if (position.node.type !== TaskList.type && checked)
        changes.push({ from: at, remove: checked });
      at += item.length;
    }
    return changes.length ? changes : null;
  },
);

export function toggleTaskItem(editor, position) {
  if (!editor.editable || editor.state.readOnly) return false;
  const node = editor.state.doc.nodeAt(position);
  const parent = editor.state.doc.resolve(position).parent;
  if (node?.type !== ListItem.type || parent?.node.type !== TaskList.type) return false;
  editor.dispatch({
    changes: { from: position, add: TaskChecked.of(node.mark(TaskChecked) !== true) },
    annotations: history.isolate.of(true),
    userEvent: "input.task.toggle",
  });
  return true;
}

const checkbox = Widget.define({
  eq: (a, b) => a.checked === b.checked && a.readOnly === b.readOnly,
  render(value, editor) {
    const label = document.createElement("label");
    label.className = "wordgard-task-control wordgard-widget";
    const input = label.appendChild(document.createElement("input"));
    input.type = "checkbox";
    input.checked = value.checked;
    // The property doesn't serialize; the attribute draws the same box in a
    // copy of this DOM (the card shell's rasterizer clones it).
    input.toggleAttribute("checked", value.checked);
    input.disabled = value.readOnly;
    input.setAttribute("aria-label", "Task complete");
    input.addEventListener("change", () => {
      // Re-resolve after peer edits; neither a cached position nor widget value
      // is authoritative when this event runs.
      const current = editor.nodeFromDOM(label.closest("li"));
      if (!current || !toggleTaskItem(editor, current.pos)) {
        input.checked = value.checked;
        return;
      }
      editor.nodeDOM(current.pos)?.querySelector('input[type="checkbox"]')?.focus();
    });
    return label;
  },
  propagateEvent: false,
});

const taskPresentation = Decoration.Tag.shape.derived(ListItem.type, (state) => {
  const readOnly = state.readOnly;
  return (tag) => {
    const checked = TaskChecked.isInSet(tag.marks);
    return checked
      ? Elt.mk("li", { class: "wordgard-task-item", "data-checked": String(checked.value) }, [
          checkbox.of({ checked: checked.value, readOnly }),
          Elt.mk("div", { class: "wordgard-task-content" }, [0]),
        ])
      : Elt.mk("li", [0]);
  };
});

export const taskListInputRule = InputRule.define({
  expr: /^ ?(?:[-+*] )?\[([ xX])\] $/,
  apply(state, match) {
    if (state.readOnly) return null;
    const { from, to } = match[0];
    if (from.textblockParent?.node.type.hasRole(Node.Role.Code)) return null;
    const trimmed = state.update({ changes: { from: from.pos, to: to.pos } });
    let next = trimmed.state;
    let changes = trimmed.changes;
    if (!listIsActive(TaskList)(next)) {
      const spec = toggleList({ state: next }, TaskList);
      if (!spec) return null;
      const wrapped = next.update(spec);
      changes = changes.compose(wrapped.changes);
      next = wrapped.state;
    }
    const item = next.sel.head.matchingParent((node) => node.type === ListItem.type);
    if (!item || item.parent?.node.type !== TaskList.type) return null;
    const marked = next.update({
      changes: { from: item.before, add: TaskChecked.of(match[1].text.toLowerCase() === "x") },
    });
    return {
      changes: changes.compose(marked.changes),
      selection: marked.state.selection,
      annotations: history.isolate.of(true),
      userEvent: "input.task.create",
    };
  },
});

// A task label is its first paragraph. Checkboxes retain native Tab/Space,
// and other blocks inside a task keep their own keyboard behavior.
function taskAtCaret(state) {
  if (state.readOnly || !state.selection.isCursor) return null;
  const label = state.sel.head.textblockParent;
  if (label?.node.type !== Paragraph.type || !label.isFirst) return null;
  const item = label.parent;
  return item?.node.type === ListItem.type && item.parent?.node.type === TaskList.type
    ? item
    : null;
}

// Extend a trailing task list if it exists, otherwise open one before the
// item's closing tag. All label text and task markers stay in the document.
function openChildList(item, after) {
  return item.content.at(-1)?.type === TaskList.type
    ? { from: after - 2, to: after }
    : { from: after - 1, to: after, insert: [TaskList] };
}

export function indentTask({ state }) {
  const item = taskAtCaret(state);
  if (!item?.previousSibling) return false;
  return {
    changes: [
      openChildList(item.previousSibling, item.before),
      { from: item.after, insert: [Plot.End, Plot.End] },
    ],
    scrollIntoView: true,
    userEvent: "input.indent",
  };
}

export function outdentTask({ state }) {
  const item = taskAtCaret(state);
  const list = item?.parent;
  if (list?.parent?.node.type !== ListItem.type || list.parent.parent?.node.type !== TaskList.type)
    return false;
  // Moving a task past its parent's later blocks would reorder native text
  // and detach passage comments. Leave Shift+Tab to the browser there.
  if (!list.isLast) return false;
  // Close the parent before this item. Later siblings become this item's
  // children, preserving the reading order of the outline.
  const before = item.isFirst
    ? { from: list.before, to: item.before, insert: [Plot.End] }
    : { from: item.before, insert: [Plot.End, Plot.End] };
  const after = item.nextSibling
    ? openChildList(item.node, item.after)
    : { from: item.after, to: list.parent.after };
  return { changes: [before, after], scrollIntoView: true, userEvent: "input.outdent" };
}

export const taskLists = () => [
  normalizeTaskItems,
  taskPresentation,
  taskListInputRule,
  KeyBinding.of({ key: "Tab", run: indentTask, allowDefault: true }),
  KeyBinding.of({ key: "Shift-Tab", run: outdentTask, allowDefault: true }),
];
