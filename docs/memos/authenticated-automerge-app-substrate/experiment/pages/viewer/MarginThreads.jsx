import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, useNow } from "./CommentThreadParts.jsx";
import { attribution, plainText, relativeTime, threadTitle } from "./comment-thread-display.mjs";
import { layoutMargin, marginFits } from "./comment-margin-layout.mjs";

const CARD_WIDTH = 248;
const GAP = 8;
const GUTTER = 24;

/**
 * Open threads as compact cards beside their passages (`?margin=1`). Cards
 * are a way in, not a second thread view: clicking one opens the comments
 * panel at that thread. When the window is too narrow the margin renders
 * nothing and the panel is the only surface.
 */
export function MarginThreads({ article, threads, activeId, onOpen }) {
  const root = useRef(null);
  const [geometry, setGeometry] = useState(null);
  const [heights, setHeights] = useState({});
  const now = useNow();
  const open = threads.filter((thread) => thread.state === "open");
  const idsKey = open.map((thread) => thread.id).join(" ");

  // Measure anchors whenever the Page lays out again. Effects only read the
  // DOM; positions come from the pure layout function.
  useEffect(() => {
    const content = article.current;
    if (!content || !root.current) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const origin = root.current?.getBoundingClientRect();
        if (!origin) return;
        const box = content.getBoundingClientRect();
        const fits = marginFits({
          viewportWidth: document.documentElement.clientWidth,
          contentRight: box.right,
          cardWidth: CARD_WIDTH,
          gutter: GUTTER,
        });
        const anchors = {};
        for (const thread of open) {
          const element = anchorElement(content, thread);
          if (element) anchors[thread.id] = element.getBoundingClientRect().top - origin.top;
        }
        setGeometry({ fits, left: box.right - origin.left + GUTTER, anchors });
      });
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(content);
    const mutations = new MutationObserver(measure);
    mutations.observe(content, { subtree: true, childList: true, characterData: true });
    addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      removeEventListener("resize", measure);
    };
    // idsKey stands in for the open threads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article, idsKey]);

  useLayoutEffect(() => {
    if (!root.current) return;
    const next = {};
    for (const card of root.current.querySelectorAll("[data-margin-thread]"))
      next[card.dataset.marginThread] = card.offsetHeight;
    const changed =
      Object.keys(next).length !== Object.keys(heights).length ||
      Object.entries(next).some(([id, height]) => heights[id] !== height);
    if (changed) setHeights(next);
  });

  const placed =
    geometry?.fits &&
    layoutMargin(
      open
        .filter((thread) => geometry.anchors[thread.id] !== undefined)
        .map((thread) => ({
          id: thread.id,
          anchorTop: geometry.anchors[thread.id],
          height: heights[thread.id] ?? 72,
        })),
      { gap: GAP, activeId },
    );
  const top = Object.fromEntries((placed || []).map((item) => [item.id, item.top]));
  return (
    <aside ref={root} className="comment-margin" aria-label="Comments beside the Page">
      {placed &&
        open
          .filter((thread) => top[thread.id] !== undefined)
          .map((thread) => {
            const messages = thread.messages.filter((message) => !message.deletedAt);
            const [first] = messages;
            const last = messages.at(-1);
            const { title } = threadTitle(first?.body);
            const replies = messages.length - 1;
            return (
              <button
                key={thread.id}
                type="button"
                data-margin-thread={thread.id}
                className={
                  "margin-thread" + (thread.id === activeId ? " margin-thread-active" : "")
                }
                style={{ top: top[thread.id], left: geometry.left, width: CARD_WIDTH }}
                onClick={() => onOpen(thread.id)}
              >
                <span className="margin-thread-meta">
                  {first && <Avatar author={first.author} size={18} />}
                  <span className="margin-thread-author">{attribution(first?.author).name}</span>
                  {last?.createdAt && (
                    <span className="muted">{relativeTime(last.createdAt, now)}</span>
                  )}
                </span>
                <span className="margin-thread-title">
                  {title || plainText(first?.body) || "Comment"}
                </span>
                {replies > 0 && (
                  <span className="muted margin-thread-replies">
                    {replies} {replies === 1 ? "reply" : "replies"}
                  </span>
                )}
              </button>
            );
          })}
    </aside>
  );
}

function anchorElement(content, thread) {
  const passage = content.querySelector(`[data-comment-thread="${CSS.escape(thread.id)}"]`);
  if (passage) return passage;
  const target = thread.target ?? {};
  const blockId = target.kind === "selection" ? target.anchor?.blockId : target.blockId;
  return blockId ? content.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`) : null;
}
