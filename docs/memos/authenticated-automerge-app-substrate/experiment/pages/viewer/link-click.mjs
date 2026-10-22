// ProseMirror's handleClick receives mouseup. Cancel the later native click as
// well: links inside read-only content otherwise navigate the current page.
export function handleLinkDOMClick(view, event, activate) {
  const anchor = event.target.closest?.("a");
  if (!anchor) return false;
  event.preventDefault();
  // Keyboard / assistive activation has no preceding mouseup. Give it the same
  // Open/Edit menu rather than swallowing an otherwise usable link.
  if (event.detail === 0) activate(view, view.posAtDOM(anchor, 0), event);
  return true;
}
