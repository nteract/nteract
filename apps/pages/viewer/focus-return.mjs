// Where focus goes when the inline composer closes from the keyboard.
//
// The composer's passage can disappear while it is open: a collaborator may
// delete its block. Focus then falls back through the editor that holds the
// Page's current selection, the first surviving editor, and the Page title,
// so it never drops to <body>.

/** The rich-text editor content of block `id` under `root`, if rendered. */
function blockEditor(root, id) {
  if (!id) return null;
  for (const block of root?.querySelectorAll(".page-block") ?? [])
    if (block.dataset.blockId === id) return block.querySelector("wg-content");
  return null;
}

/**
 * The element to focus after the composer closes. `blockIds` are tried in
 * order: the draft's block, then the block whose editor holds the current
 * selection. Then the first editor still on the Page, then `title`.
 * Returns null only when none of them is connected.
 */
export function focusReturnTarget(root, { blockIds = [], title = null } = {}) {
  for (const id of blockIds) {
    const editor = blockEditor(root, id);
    if (editor?.isConnected) return editor;
  }
  const first = root?.querySelector(".page-block wg-content");
  if (first?.isConnected) return first;
  return title?.isConnected ? title : null;
}
