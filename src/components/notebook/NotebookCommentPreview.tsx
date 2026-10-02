import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  CommentComposer,
  CommentMessage,
  type NotebookCommentsPanelProps,
} from "./NotebookCommentsPanel";

/** Shared highlight interactions for source editors and rendered Markdown. */
export function NotebookCommentPreview({
  children,
  projection,
  readOnly = false,
  onReplyThread,
  resolveCommentAuthor,
}: Pick<
  NotebookCommentsPanelProps,
  "projection" | "readOnly" | "onReplyThread" | "resolveCommentAuthor"
> & { children: ReactNode }) {
  const [target, setTarget] = useState<{
    id: string;
    element: HTMLElement;
    pinned: boolean;
  } | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 640px)");
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const thread = projection?.threads.find(
    (item) => item.id === target?.id && item.status !== "resolved",
  );
  const cancelTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    cancelTimer();
    setTarget(null);
    setError(null);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const highlight = (node: EventTarget | null) => {
    const element =
      node instanceof Element ? node.closest<HTMLElement>("[data-comment-thread-id]") : null;
    const id = element?.dataset.commentThreadId;
    return element &&
      id &&
      projection?.threads.some((item) => item.id === id && item.status !== "resolved")
      ? { id, element }
      : null;
  };
  const open = (anchor: { id: string; element: HTMLElement }, pinned: boolean) => {
    cancelTimer();
    setError(null);
    setTarget({ ...anchor, pinned });
  };
  const leave = () => {
    cancelTimer();
    timer.current = setTimeout(() => {
      setTarget((current) =>
        current?.pinned || card.current?.contains(document.activeElement) ? current : null,
      );
    }, 250);
  };

  return (
    <div
      className="contents"
      onPointerOver={(event) => {
        const anchor = highlight(event.target);
        if (!anchor || target?.pinned) return;
        cancelTimer();
        timer.current = setTimeout(() => open(anchor, false), 250);
      }}
      onPointerOut={(event) => {
        if (highlight(event.target)) leave();
      }}
      onClickCapture={(event) => {
        const anchor = highlight(event.target);
        if (!anchor) return;
        event.stopPropagation();
        if (window.getSelection()?.isCollapsed === false) return;
        event.preventDefault();
        open(anchor, true);
      }}
      onKeyDownCapture={(event) => {
        const anchor = highlight(event.target);
        if (!anchor || (event.key !== "Enter" && event.key !== " ")) return;
        event.stopPropagation();
        event.preventDefault();
        returnFocus.current = anchor.element;
        open(anchor, true);
        requestAnimationFrame(() => card.current?.focus({ preventScroll: true }));
      }}
    >
      {children}
      <Popover
        open={Boolean(thread && target)}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        {target ? <PopoverAnchor virtualRef={{ current: target.element }} /> : null}
        {thread && target ? (
          <PopoverContent
            ref={card}
            aria-label="Comment thread"
            side={narrow ? "bottom" : "right"}
            align="start"
            sideOffset={12}
            collisionPadding={12}
            sticky="always"
            hideWhenDetached
            updatePositionStrategy="always"
            className="w-[360px] max-w-[calc(100vw-24px)] rounded-2xl p-4 shadow-lg"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              returnFocus.current?.focus({ preventScroll: true });
              returnFocus.current = null;
            }}
            onPointerEnter={cancelTimer}
            onPointerLeave={leave}
            onFocusCapture={() =>
              setTarget((current) => (current ? { ...current, pinned: true } : null))
            }
            onInteractOutside={(event) => {
              if (highlight(event.target)) event.preventDefault();
              else returnFocus.current = null;
            }}
          >
            <button
              type="button"
              aria-label="Close comment preview"
              onClick={close}
              className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
            <div className="max-h-[min(50vh,400px)] space-y-4 overflow-y-auto pr-5">
              {thread.messages.map((message) => (
                <CommentMessage
                  key={message.id}
                  message={message}
                  resolveCommentAuthor={resolveCommentAuthor}
                />
              ))}
            </div>
            {error ? (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            {!readOnly && onReplyThread ? (
              <div className="mt-4 border-l border-border pl-4 ml-2">
                <CommentComposer
                  key={thread.id}
                  ariaLabel="Reply to comment"
                  submitAriaLabel="Send reply"
                  placeholder="Reply…"
                  disabled={false}
                  compact
                  value={drafts[thread.id] ?? ""}
                  onValueChange={(body) =>
                    setDrafts((current) => ({ ...current, [thread.id]: body }))
                  }
                  onSubmit={async (body) => {
                    setError(null);
                    try {
                      await onReplyThread(thread.id, body);
                    } catch (failure) {
                      setError(failure instanceof Error ? failure.message : "Reply failed.");
                      throw failure;
                    }
                  }}
                />
              </div>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
    </div>
  );
}
