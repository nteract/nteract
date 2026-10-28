import { Elt, Node } from "wordgard/doc";
import { Correction } from "wordgard/state";
import { Decoration, InputRule, Widget } from "wordgard/editor";
import { toggleList, listIsActive } from "wordgard/command";
import { history } from "wordgard/history";
import { ListItem, BulletList, OrderedList, TaskList, TaskChecked } from "./wordgard-model.mjs";

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

export const taskLists = () => [normalizeTaskItems, taskPresentation, taskListInputRule];
