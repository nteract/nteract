import { ArrowUp } from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { SourceCommentSelectionRect } from "../lib/comment-source-anchor";

export interface InlineCommentComposerProps {
  /** Viewport-space rectangle of the selection the comment is anchored to. */
  rect: SourceCommentSelectionRect;
  /** Selected source text; selection highlighting in the document carries the preview. */
  quote?: string | null;
  disabled?: boolean;
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
}

const AUTHOR_COLOR = "var(--comment-author-color, var(--primary, #2563eb))";

export function InlineCommentComposer({
  rect,
  disabled = false,
  onSubmit,
  onCancel,
}: InlineCommentComposerProps) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const justOpenedRef = useRef(true);

  useEffect(() => {
    textareaRef.current?.focus();
    // Ignore outside-interactions for a beat after opening, so the event that
    // opened this composer (a context menu closing and returning focus to the
    // editor) does not immediately dismiss it.
    const settle = window.setTimeout(() => {
      justOpenedRef.current = false;
    }, 300);
    return () => window.clearTimeout(settle);
  }, []);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || disabled || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } catch {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter submits. There is no Cancel button: the input is the whole
    // composer, and the Popover already backs out on Escape and click-away
    // (onOpenChange -> onCancel), so we don't handle Escape here or it fires twice.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const anchorStyle: CSSProperties = {
    position: "fixed",
    left: rect.left,
    top: rect.top,
    width: Math.max(1, rect.right - rect.left),
    height: Math.max(1, rect.bottom - rect.top),
    pointerEvents: "none",
  };

  // The composer fills with the author color and reads as a colored button:
  // white text and arrow, rather than the marginally-higher-contrast dark, which
  // looks muddy on the saturated palette colors. The send chip is a subtle dark
  // veil so the white arrow stays visible on any author color.
  const surfaceStyle: CSSProperties = {
    background: AUTHOR_COLOR,
    color: "#ffffff",
  };
  const textareaStyle: CSSProperties = {
    "--comment-composer-placeholder-color": "rgba(255, 255, 255, 0.72)",
    caretColor: "#ffffff",
    color: "#ffffff",
  } as CSSProperties;
  const buttonStyle: CSSProperties = { background: "rgba(0, 0, 0, 0.2)", color: "#ffffff" };
  const canSubmit = !disabled && !submitting && body.trim().length > 0;

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <PopoverAnchor asChild>
        <div aria-hidden style={anchorStyle} />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-80 rounded-2xl border-0 p-2.5 shadow-none focus-visible:outline-none"
        style={surfaceStyle}
        data-testid="inline-comment-composer"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          textareaRef.current?.focus();
        }}
        onPointerDownOutside={(event) => {
          if (justOpenedRef.current) event.preventDefault();
        }}
        onFocusOutside={(event) => {
          if (justOpenedRef.current) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (justOpenedRef.current) event.preventDefault();
        }}
      >
        <form onSubmit={handleSubmit}>
          <div className="relative">
            <textarea
              ref={textareaRef}
              aria-label="Comment on selection"
              value={body}
              disabled={disabled || submitting}
              placeholder="Add a comment"
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              style={textareaStyle}
              className={cn(
                "min-h-16 w-full resize-none border-0 bg-transparent py-1 pl-1 pr-10 text-sm leading-5",
                "placeholder:text-[var(--comment-composer-placeholder-color)]",
                "focus-visible:outline-none",
                (disabled || submitting) && "cursor-not-allowed opacity-60",
              )}
            />
            <button
              type="submit"
              aria-label="Comment"
              disabled={!canSubmit}
              style={buttonStyle}
              className={cn(
                "absolute bottom-1 right-0 inline-flex size-8 items-center justify-center rounded-full transition-opacity",
                !canSubmit && "cursor-not-allowed opacity-40",
              )}
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
