import { useEffect, useRef, useState } from "react";

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
        const lit = target.querySelector(".copy-passage-active");
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
  // Copies get their own passage classes and attribute, so nothing that
  // looks for the Page's passages (scrolling, hover, tests) finds a copy.
  for (const passage of copy.querySelectorAll(".comment-passage")) {
    const id = passage.dataset.commentThread;
    passage.removeAttribute("data-comment-thread");
    passage.className = "copy-passage" + (id === threadId ? " copy-passage-active" : "");
  }
  for (const draft of copy.querySelectorAll(".comment-draft-passage")) draft.className = "";
  // Editing chrome (carets, selection, block handles) isn't part of the Page.
  for (const chrome of copy.querySelectorAll(
    ".peer-caret, .remote-caret, .block-handle, .block-actions, [data-editor-chrome]",
  ))
    chrome.remove();
  return copy;
}

const PARAGRAPH = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, figcaption";

/**
 * The paragraph around a thread's passage as the Page renders it, so marks,
 * links and code keep their formatting. Read-only, clipped to a few lines
 * around the passage. Falls back to `children` (a plain-text excerpt) when
 * the passage isn't rendered, such as a block comment or a detached thread.
 */
export function PassageSnippet({ thread, children }) {
  const host = useRef(null);
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    let frame = 0;
    const find = () =>
      document.querySelector(`.document [data-comment-thread="${CSS.escape(thread.id)}"]`);
    const render = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const passage = find();
        const paragraph = passage?.closest(PARAGRAPH);
        if (!paragraph || !paragraph.closest(".document")) {
          target.replaceChildren();
          setRendered(false);
          return;
        }
        const copy = readOnlyCopy(paragraph, thread.id);
        copy.classList.add("passage-snippet-paragraph");
        target.replaceChildren(copy);
        setRendered(true);
        // Bring the passage into the clipped window, a line from the top.
        const lit = target.querySelector(".copy-passage-active");
        if (lit) {
          const line = parseFloat(window.getComputedStyle(target).lineHeight) || 20;
          target.scrollTop = Math.max(0, lit.offsetTop - copy.offsetTop - line);
        }
      });
    };
    render();
    const source = find()?.closest(".page-block");
    const observer = new MutationObserver(render);
    if (source) observer.observe(source, { subtree: true, childList: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [thread.id]);
  return (
    <>
      <div
        ref={host}
        className="passage-snippet document-copy"
        hidden={!rendered}
        inert
        aria-hidden={!rendered || undefined}
      />
      {!rendered && children}
    </>
  );
}
