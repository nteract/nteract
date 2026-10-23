import { AllSelection, EditorState, Plugin, TextSelection } from "prosemirror-state";
import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { undo, redo } from "prosemirror-history";

export const textStyles = [
  { value: "paragraph", label: "Paragraph" },
  { value: "heading1", label: "Heading 1" },
  { value: "heading2", label: "Heading 2" },
  { value: "heading3", label: "Heading 3" },
  { value: "quote", label: "Quote" },
  { value: "code_block", label: "Code block" },
];

function sharedAncestor(state, matches) {
  const { $from, $to } =
    state.selection instanceof AllSelection
      ? TextSelection.between(state.selection.$from, state.selection.$to)
      : state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (matches(node) && $to.pos <= $from.end(depth))
      return { node, depth, pos: $from.before(depth) };
  }
  return null;
}

function selectedList(state) {
  return sharedAncestor(state, (node) => ["bullet_list", "ordered_list"].includes(node.type.name));
}

// Switching list kinds changes the existing container, rather than wrapping a
// second list around it. Toggling the active kind lifts the selected items.
export function toggleList(listType) {
  return (state, dispatch) => {
    if (state.selection instanceof AllSelection)
      return structuralCommand((current, run) => run(toggleList(listType)))(state, dispatch);
    const list = selectedList(state);
    if (!list) return wrapInList(listType)(state, dispatch);
    if (list.node.type === listType)
      return liftListItem(state.schema.nodes.list_item)(state, dispatch);
    if (!listType.validContent(list.node.content)) return false;
    if (dispatch)
      dispatch(state.tr.setNodeMarkup(list.pos, listType, list.node.attrs).scrollIntoView());
    return true;
  };
}

function selectedTextblocks(state) {
  const { from, to, $from, empty } = state.selection;
  if (empty) return $from.parent.isTextblock ? [{ node: $from.parent, pos: $from.before() }] : [];
  const blocks = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return;
    blocks.push({ node, pos });
    return false;
  });
  return blocks;
}

function blockStyle(doc, node, pos) {
  const $inside = doc.resolve(pos + 1);
  for (let depth = $inside.depth - 1; depth > 0; depth--)
    if ($inside.node(depth).type.name === "blockquote") return "quote";
  if (node.type.name === "heading") return `heading${node.attrs.level}`;
  return node.type.name;
}

export function selectedTextStyle(state) {
  const styles = selectedTextblocks(state).map(({ node, pos }) => blockStyle(state.doc, node, pos));
  return styles.length && styles.every((value) => value === styles[0]) ? styles[0] : "mixed";
}

// Compose structural steps without running the live binding's plugins during a
// capability check. Only the final transaction reaches the editor and Automerge.
function structuralCommand(build) {
  return (state, dispatch) => {
    let scratch = EditorState.create({
      schema: state.schema,
      doc: state.doc,
      selection:
        state.selection instanceof AllSelection
          ? TextSelection.between(state.selection.$from, state.selection.$to)
          : state.selection,
      storedMarks: state.storedMarks,
    });
    const steps = [];
    const run = (command) =>
      command(scratch, (tr) => {
        steps.push(...tr.steps);
        scratch = scratch.apply(tr);
      });
    if (!build(() => scratch, run) || !steps.length) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const step of steps) tr.step(step);
      tr.setSelection(scratch.selection.getBookmark().resolve(tr.doc));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

function textStyleCommand(schema, value) {
  if (value === "quote")
    return (state, dispatch) => {
      if (sharedAncestor(state, (node) => node.type === schema.nodes.blockquote)) return false;
      return wrapIn(schema.nodes.blockquote)(state, dispatch);
    };
  const type = value.startsWith("heading") ? schema.nodes.heading : schema.nodes[value];
  if (!type || !["paragraph", "heading1", "heading2", "heading3", "code_block"].includes(value))
    return () => false;
  const attrs = type === schema.nodes.heading ? { level: Number(value.slice(-1)) } : null;
  const setType = setBlockType(type, attrs);
  const exitQuote = structuralCommand((current, run) => {
    // Choosing a normal text style exits surrounding quotes. The scratch state
    // makes the lift and type change one undoable, replicated transaction.
    for (let depth = 0; depth < 32; depth++) {
      if (!sharedAncestor(current(), (node) => node.type === schema.nodes.blockquote)) break;
      if (!run(lift)) return false;
    }
    // A selection spanning quoted and unquoted containers cannot be lifted as
    // one range. Disable that conversion instead of leaving a hidden quote.
    if (
      selectedTextblocks(current()).some(
        ({ node, pos }) => blockStyle(current().doc, node, pos) === "quote",
      )
    )
      return false;
    run(setType);
    return true;
  });
  return (state, dispatch) => {
    const quoted = selectedTextblocks(state).some(
      ({ node, pos }) => blockStyle(state.doc, node, pos) === "quote",
    );
    return quoted ? exitQuote(state, dispatch) : setType(state, dispatch);
  };
}

export function setTextStyle(schema, value) {
  const command = textStyleCommand(schema, value);
  return (state, dispatch) => {
    // Opaque Markdown stores its source in attributes, not editable child text.
    // Converting that atom to a paragraph would silently discard the source.
    if (selectedTextblocks(state).some(({ node }) => node.isAtom)) return false;
    return command(state, dispatch);
  };
}

export function createToolbarCommands(schema) {
  return {
    undo,
    redo,
    bold: toggleMark(schema.marks.strong),
    italic: toggleMark(schema.marks.em),
    code: toggleMark(schema.marks.code),
    bullet_list: toggleList(schema.nodes.bullet_list),
    ordered_list: toggleList(schema.nodes.ordered_list),
    styles: Object.fromEntries(textStyles.map(({ value }) => [value, setTextStyle(schema, value)])),
  };
}

// A mixed range is an actual toggle state; a collapsed cursor uses storedMarks
// first so Cmd-B is visible before the user types the next character.
export function selectedMark(state, type) {
  const { empty, $from, ranges } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  let marked = false,
    unmarked = false;
  for (const { $from: start, $to: end } of ranges) {
    state.doc.nodesBetween(start.pos, end.pos, (node, _pos, parent) => {
      if (!node.isInline || !parent?.type.allowsMarkType(type)) return;
      if (type.isInSet(node.marks)) marked = true;
      else unmarked = true;
    });
  }
  return marked && unmarked ? "mixed" : marked;
}

export function toolbarSnapshot(state, commands = createToolbarCommands(state.schema)) {
  const list = selectedList(state)?.node.type.name;
  const marks = { bold: "strong", italic: "em", code: "code" };
  const controls = Object.fromEntries(
    Object.entries(commands)
      .filter(([name]) => name !== "styles")
      .map(([name, command]) => [
        name,
        {
          enabled: command(state),
          ...(marks[name] ? { pressed: selectedMark(state, state.schema.marks[marks[name]]) } : {}),
          ...(["bullet_list", "ordered_list"].includes(name) ? { pressed: list === name } : {}),
        },
      ]),
  );
  return {
    controls,
    style: selectedTextStyle(state),
    styles: Object.fromEntries(
      Object.entries(commands.styles).map(([name, command]) => [name, command(state)]),
    ),
  };
}

export function observeToolbar(onChange, commands) {
  return new Plugin({
    view(view) {
      let previous;
      const publish = (state) => {
        const snapshot = toolbarSnapshot(state, commands);
        const serialized = JSON.stringify(snapshot);
        if (serialized !== previous) {
          previous = serialized;
          onChange(snapshot);
        }
      };
      publish(view.state);
      return { update: (nextView) => publish(nextView.state) };
    },
  });
}
