import { GardState } from "wordgard/state";
import { applyPageOperation } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { blockAddress } from "../model/addresses.mjs";
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

/** A new empty block after the last one. An insert with no anchor writes
 * into the last block, so this names the last block's id. */
function newBlock(session) {
  let id;
  session.change((doc) => {
    const last = orderedBlockIds(doc).at(-1);
    applyPageOperation(doc, {
      operation: "edit_page",
      arguments: {
        operations: [
          {
            op: "insert_markdown",
            markdown: "",
            ...(last && { after_node_id: blockAddress(doc, last) }),
          },
        ],
      },
    });
    id = orderedBlockIds(doc).at(-1);
  });
  return id;
}

/** Write continueAtEnd into block `id` with no editor on screen: the same
 * edit, committed through a binding as the block's editor would commit it.
 * Returns false for a block the editor would draw read-only (lossy: content
 * from a newer build, or a tree that differs from what is stored), and for
 * one this build can't decode at all, which the Page draws as a notice. */
function continueInBlock(session, id, blank) {
  let binding;
  try {
    binding = createWordgardBinding(session, id);
  } catch {
    return false;
  }
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
 * selection is left in the paragraph; an edit that editor rolls back returns
 * null and writes nothing. Without one, the same edit is committed through a
 * binding of the block.
 *
 * A last block nobody can write inside gets a new empty block after it, so a
 * person can still add to the Page: its editor is read-only, it holds content
 * this build draws lossily or can't decode, or `failed(id)` says the Page
 * shows a notice in its place because drawing it threw. A paragraph written
 * into a block with no editor on screen would have no caret to take.
 */
export function writingContinuation(session, { editorOf, failed } = {}) {
  if (!session?.alive || !session.canWrite) return null;
  const id = orderedBlockIds(session.doc).at(-1);
  if (!id || failed?.(id)) return newBlock(session);
  const blank = isBlankBlock(session.doc.blocks[id]);
  const view = editorOf?.(id);
  if (view && !view.state.readOnly) {
    const spec = continueAtEnd(view.state, { blank });
    if (spec) view.dispatch(spec);
    // The editor rolls back a write the Page refuses and reports it itself.
    // Nothing else is tried, so its report stays true: pressing again does.
    return atContinuation(view.state) ? id : null;
  }
  if (!view && continueInBlock(session, id, blank)) return id;
  return newBlock(session);
}

/** Put block `view`'s caret where writingContinuation left the paragraph, for
 * an editor that mounted after the write. Writes nothing. */
export function placeContinuationCaret(view) {
  const spec = view && continueAtEnd(view.state, { blank: true });
  if (spec && !spec.changes) view.dispatch(spec);
}
