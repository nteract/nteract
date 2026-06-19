import { MessageSquarePlus } from "lucide-react";
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
  /** Selected source text, shown as a quote preview above the input. */
  quote?: string | null;
  disabled?: boolean;
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
}

const MAX_QUOTE_PREVIEW_CHARS = 160;

export function InlineCommentComposer({
  rect,
  quote,
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

  const preview = formatQuotePreview(quote);

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
        className="w-80 space-y-2 p-3"
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
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MessageSquarePlus className="size-3.5" aria-hidden="true" />
          Comment on selection
        </div>
        {preview ? (
          <blockquote className="max-h-16 overflow-hidden whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs leading-5 text-foreground">
            {preview}
          </blockquote>
        ) : null}
        <form className="space-y-2" onSubmit={handleSubmit}>
          <textarea
            ref={textareaRef}
            aria-label="Comment on selection"
            value={body}
            disabled={disabled || submitting}
            placeholder="Add a comment"
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            className={cn(
              "min-h-16 w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm leading-5",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              (disabled || submitting) && "cursor-not-allowed opacity-60",
            )}
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex min-h-8 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={disabled || submitting || body.trim().length === 0}
              className="inline-flex min-h-8 items-center rounded-md border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              Comment
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function formatQuotePreview(quote: string | null | undefined): string | null {
  if (!quote) return null;
  const trimmed = quote.trim();
  if (trimmed.length === 0) return null;
  if (quote.length <= MAX_QUOTE_PREVIEW_CHARS) return quote;
  return `${quote.slice(0, MAX_QUOTE_PREVIEW_CHARS - 3)}...`;
}
