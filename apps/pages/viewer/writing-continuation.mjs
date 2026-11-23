import { GardState } from "wordgard/state";
import { applyPageOperation } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { isBlankBlock } from "../model/richtext-format.mjs";
import { elements } from "./wordgard-model.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { atContinuation, continueAtEnd } from "./wordgard-leave-block.mjs";

/** Whether a Page document is still empty: one block with nothing a reader
 * would see, as a new Page starts. Such a Page opens with the caret in that
 * block. Reads the stored spans, not the Markdown projection. */
export function isEmptyPage(doc) {
  if (!doc?.blocks) return false;
  const ids = orderedBlockIds(doc);
  return ids.length === 1 && isBlankBlock(doc.blocks[ids[0]]);
}

function newBlock(session) {
  let id;
  session.change((doc) => {
    applyPageOperation(doc, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown: "" }] },
    });
    id = orderedBlockIds(doc).at(-1);
  });
  return id;
}

/** Write continueAtEnd into block `id` with no editor on screen: the same
 * edit, committed through a binding as the block's editor would commit it.
 * Returns false for a block the editor would draw read-only (lossy: content
 * from a newer build, or a tree that differs from what is stored). */
function continueInBlock(session, id, blank) {
  const binding = createWordgardBinding(session, id);
  try {
    const projection = binding.current;
    if (projection.lossy) return false;
    const state = GardState.create({
      doc: projection.doc,
      config: [GardState.schemaElement.of(elements)],
    });
    const spec = continueAtEnd(state, { blank });
    if (spec.changes) binding.applyEditorTransaction(state.update(spec));
    return true;
  } finally {
    binding.destroy();
  }
}

/**
 * "Continue writing" below the last block: an empty paragraph at the end of
 * the last block, inside that block, so the Page stays one flow a selection
 * can cross. Returns the block's id, or null for a read-only or closed
 * session, which writes nothing.
 *
 * - A Page with no block gets its first block.
 * - A last block that is blank, or ends in an empty paragraph, is left as it
 *   is: the caret goes in that paragraph. Repeated activation writes nothing.
 * - Otherwise one empty paragraph is added after the block's last node.
 *   Existing nodes keep their markers, so node ids and comment anchors stay.
 *
 * `editorOf(id)` returns block `id`'s mounted Wordgard editor, if any. With
 * one that is editable, the edit is dispatched there (continueAtEnd, the same
 * edit ArrowDown and Mod-Enter make below a final node) and the editor's
 * selection is left in the paragraph. Without one, the same edit is committed
 * through a binding of the block.
 *
 * A last block nobody can write inside (its editor is read-only, or it holds
 * content this build draws lossily) gets a new empty block after it, so a
 * person can still add to the Page.
 */
export function writingContinuation(session, { editorOf } = {}) {
  if (!session?.alive || !session.canWrite) return null;
  const id = orderedBlockIds(session.doc).at(-1);
  if (!id) return newBlock(session);
  const blank = isBlankBlock(session.doc.blocks[id]);
  const view = editorOf?.(id);
  if (view && !view.state.readOnly) {
    const spec = continueAtEnd(view.state, { blank });
    if (spec) view.dispatch(spec);
    // The editor reports and rolls back a write the Page refuses.
    if (atContinuation(view.state)) return id;
  }
  if (!view?.state.readOnly && continueInBlock(session, id, blank)) return id;
  return newBlock(session);
}

/** Put block `view`'s caret where writingContinuation left the paragraph, for
 * an editor that mounted after the write. Writes nothing. */
export function placeContinuationCaret(view) {
  const spec = view && continueAtEnd(view.state, { blank: true });
  if (spec && !spec.changes) view.dispatch(spec);
}
