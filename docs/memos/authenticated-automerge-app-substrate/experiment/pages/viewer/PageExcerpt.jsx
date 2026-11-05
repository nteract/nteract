import { useEffect, useRef } from "react";

/**
 * The block a thread points at, shown as the Page renders it: tables stay
 * tables, task lists keep their boxes. It's a read-only copy of the live
 * editor's DOM, refreshed when that block changes, with this thread's
 * passage lit and scrolled into view. Nothing here can edit the Page.
 */
export function PageExcerpt({ thread }) {
  const host = useRef(null);
  const blockId = blockOf(thread);
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    let frame = 0;
    const source = () =>
      blockId ? document.querySelector(`.document [data-block-id="${CSS.escape(blockId)}"]`) : null;
    const render = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const block = source();
        target.replaceChildren();
        if (!block) {
          const empty = document.createElement("p");
          empty.className = "muted page-excerpt-missing";
          empty.textContent = "This passage is no longer in the Page.";
          target.append(empty);
          return;
        }
        target.append(readOnlyCopy(block, thread.id));
        const lit = target.querySelector(".comment-passage-active");
        if (lit) {
          const box = target.getBoundingClientRect();
          const at = lit.getBoundingClientRect();
          target.scrollTop += at.top - box.top - box.height / 3;
        } else target.scrollTop = 0;
      });
    };
    render();
    const block = source();
    const observer = new MutationObserver(render);
    if (block)
      observer.observe(block, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [blockId, thread.id]);
  return <div ref={host} className="page-excerpt document-copy" inert />;
}

function blockOf(thread) {
  const context = thread?.selectionContext;
  if (context?.status === "attached" && context.start) return context.start.blockId;
  const target = thread?.target ?? {};
  return target.kind === "block" ? target.blockId : (target.anchor?.blockId ?? null);
}

/** A copy of `block` that can't take focus or edits, lighting `threadId`. */
export function readOnlyCopy(block, threadId) {
  const copy = block.cloneNode(true);
  for (const element of [copy, ...copy.querySelectorAll("*")]) {
    element.removeAttribute("id");
    element.removeAttribute("contenteditable");
    element.removeAttribute("tabindex");
    element.removeAttribute("aria-describedby");
    if (element.matches?.("input, textarea, select, button")) element.setAttribute("disabled", "");
  }
  for (const passage of copy.querySelectorAll(".comment-passage")) {
    passage.classList.remove("comment-passage-active", "comment-passage-created");
    if (passage.dataset.commentThread === threadId) passage.classList.add("comment-passage-active");
  }
  // Editing chrome (carets, selection, block handles) isn't part of the Page.
  for (const chrome of copy.querySelectorAll(
    ".peer-caret, .remote-caret, .block-handle, .block-actions, [data-editor-chrome]",
  ))
    chrome.remove();
  return copy;
}
