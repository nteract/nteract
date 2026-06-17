import { CheckCircle2, MessageSquare, Plus, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  CommentAnchor,
  CommentMessageSnapshot,
  CommentThreadSnapshot,
  CommentsProjection,
} from "runtimed";
import { cn } from "@/lib/utils";

export interface NotebookCommentDraftTarget {
  anchor: CommentAnchor;
  quote?: string | null;
}

export interface NotebookCommentsPanelProps {
  projection: CommentsProjection | null;
  readOnly?: boolean;
  draftTarget?: NotebookCommentDraftTarget | null;
  statusMessage?: string | null;
  errorMessage?: string | null;
  onClearDraftTarget?: () => void;
  onCreateThread?: (body: string) => void | Promise<void>;
  onReplyThread?: (threadId: string, body: string) => void | Promise<void>;
  onResolveThread?: (threadId: string) => void | Promise<void>;
  onReopenThread?: (threadId: string) => void | Promise<void>;
}

export function NotebookCommentsPanel({
  projection,
  readOnly = false,
  draftTarget = null,
  statusMessage = null,
  errorMessage = null,
  onClearDraftTarget,
  onCreateThread,
  onReplyThread,
  onResolveThread,
  onReopenThread,
}: NotebookCommentsPanelProps) {
  const threads = projection?.threads ?? [];
  const canCreate = !readOnly && Boolean(onCreateThread);
  const canReply = !readOnly && Boolean(onReplyThread);
  const canUpdateStatus = !readOnly && (Boolean(onResolveThread) || Boolean(onReopenThread));

  return (
    <section className="flex min-h-0 flex-col gap-3" data-testid="notebook-comments-panel">
      {statusMessage ? (
        <div
          className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
          role="status"
        >
          {statusMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}

      {draftTarget ? (
        <CommentDraftTargetView target={draftTarget} onClear={onClearDraftTarget} />
      ) : null}

      <CommentComposer
        ariaLabel={
          draftTarget
            ? `New ${anchorLabelForDraft(draftTarget.anchor)} comment`
            : "New document comment"
        }
        buttonLabel="Add comment"
        icon="plus"
        disabled={!canCreate}
        autoFocusKey={draftTarget ? draftAutoFocusKey(draftTarget) : null}
        placeholder={
          draftTarget
            ? `Add a ${anchorLabelForDraft(draftTarget.anchor)} comment`
            : "Add a document comment"
        }
        onSubmit={onCreateThread}
      />

      {projection && threads.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          <MessageSquare className="size-4" aria-hidden="true" />
          <span>No comments yet.</span>
        </div>
      ) : (
        <ol className="space-y-3">
          {threads.map((thread, index) => (
            <CommentThreadItem
              key={thread.id}
              thread={thread}
              threadLabel={`${anchorLabel(thread)} comment ${index + 1}`}
              canReply={canReply}
              canUpdateStatus={canUpdateStatus}
              onReplyThread={onReplyThread}
              onResolveThread={onResolveThread}
              onReopenThread={onReopenThread}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function CommentDraftTargetView({
  target,
  onClear,
}: {
  target: NotebookCommentDraftTarget;
  onClear?: () => void;
}) {
  const quote = formatQuotePreview(target.quote ?? sourceQuoteFromAnchor(target.anchor));

  return (
    <div
      className="rounded-md border bg-muted/25 px-3 py-2 text-sm"
      data-testid="comment-draft-target"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">
            {formatStateLabel(anchorLabelForDraft(target.anchor))} selection
          </div>
          {quote ? (
            <blockquote className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs leading-5 text-foreground">
              {quote}
            </blockquote>
          ) : null}
        </div>
        {onClear ? (
          <button
            type="button"
            aria-label="Use document target"
            title="Use document target"
            onClick={onClear}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CommentThreadItem({
  thread,
  threadLabel,
  canReply,
  canUpdateStatus,
  onReplyThread,
  onResolveThread,
  onReopenThread,
}: {
  thread: CommentThreadSnapshot;
  threadLabel: string;
  canReply: boolean;
  canUpdateStatus: boolean;
  onReplyThread?: (threadId: string, body: string) => void | Promise<void>;
  onResolveThread?: (threadId: string) => void | Promise<void>;
  onReopenThread?: (threadId: string) => void | Promise<void>;
}) {
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const hasUnsettledMessages = thread.messages.some(
    (message) => message.mutation_state === "pending" || message.mutation_state === "unverified",
  );
  const statusActionEnabled =
    canUpdateStatus && thread.mutation_state === "accepted" && !hasUnsettledMessages;
  const statusAction =
    thread.status === "resolved"
      ? {
          label: "Reopen",
          icon: RotateCcw,
          onClick: () => onReopenThread?.(thread.id),
          ariaLabel: `Reopen ${threadLabel}`,
          disabled: !statusActionEnabled || !onReopenThread,
        }
      : {
          label: "Resolve",
          icon: CheckCircle2,
          onClick: () => onResolveThread?.(thread.id),
          ariaLabel: `Resolve ${threadLabel}`,
          disabled: !statusActionEnabled || !onResolveThread,
        };
  const StatusIcon = statusAction.icon;
  const handleStatusAction = async () => {
    if (statusAction.disabled) return;
    setStatusSubmitting(true);
    try {
      await statusAction.onClick();
    } finally {
      setStatusSubmitting(false);
    }
  };

  return (
    <li className="rounded-md border bg-card text-card-foreground shadow-sm">
      <div className="space-y-3 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-muted-foreground">{threadLabel}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <CommentBadge state={thread.status} />
              {thread.mutation_state !== "accepted" ? (
                <CommentBadge state={thread.mutation_state} />
              ) : null}
            </div>
          </div>
          <span
            aria-label={`${thread.messages.length} ${
              thread.messages.length === 1 ? "message" : "messages"
            }`}
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {thread.messages.length}
          </span>
        </div>

        <CommentAnchorQuote quote={sourceQuoteFromAnchor(thread.anchor)} />

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleStatusAction}
            disabled={statusAction.disabled || statusSubmitting}
            aria-label={statusAction.ariaLabel}
            className="inline-flex min-h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <StatusIcon className="size-3.5" aria-hidden="true" />
            {statusAction.label}
          </button>
        </div>

        <div className="space-y-2">
          {thread.messages.map((message) => (
            <CommentMessage key={message.id} message={message} />
          ))}
        </div>

        <CommentComposer
          ariaLabel={`Reply to ${threadLabel}`}
          buttonAriaLabel={`Submit reply to ${threadLabel}`}
          buttonLabel="Reply"
          icon="send"
          disabled={!canReply}
          placeholder="Reply"
          onSubmit={onReplyThread ? (body) => onReplyThread(thread.id, body) : undefined}
        />
      </div>
    </li>
  );
}

function CommentMessage({ message }: { message: CommentMessageSnapshot }) {
  return (
    <article className="space-y-1 rounded bg-muted/35 px-2.5 py-2">
      <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
        {message.body}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        {message.mutation_state !== "accepted" ? (
          <CommentBadge state={message.mutation_state} compact />
        ) : null}
        {message.created_by_actor_label ? (
          <span title={message.created_by_actor_label}>
            {formatActorLabel(message.created_by_actor_label)}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function CommentAnchorQuote({ quote }: { quote: string | null }) {
  const preview = formatQuotePreview(quote);
  if (!preview) return null;

  return (
    <blockquote
      className="max-h-24 overflow-hidden whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs leading-5 text-foreground"
      data-testid="comment-thread-source-quote"
    >
      {preview}
    </blockquote>
  );
}

function CommentComposer({
  ariaLabel,
  buttonAriaLabel,
  buttonLabel,
  icon,
  disabled,
  autoFocusKey = null,
  placeholder,
  onSubmit,
}: {
  ariaLabel: string;
  buttonAriaLabel?: string;
  buttonLabel: string;
  icon: "plus" | "send";
  disabled: boolean;
  autoFocusKey?: string | null;
  placeholder: string;
  onSubmit?: (body: string) => void | Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const Icon = icon === "plus" ? Plus : Send;

  useEffect(() => {
    if (!autoFocusKey || disabled) return;
    let cancelled = false;
    const focus = () => {
      if (!cancelled) textareaRef.current?.focus();
    };
    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      const frame = window.requestAnimationFrame(focus);
      return () => {
        cancelled = true;
        window.cancelAnimationFrame(frame);
      };
    }
    focus();
    return () => {
      cancelled = true;
    };
  }, [autoFocusKey, disabled]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || disabled || !onSubmit) return;
    setBody("");
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } catch {
      setBody(trimmed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-2" onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        value={body}
        disabled={disabled || submitting}
        placeholder={placeholder}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        className={cn(
          "min-h-20 w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm leading-5",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
          (disabled || submitting) && "cursor-not-allowed opacity-60",
        )}
      />
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={disabled || submitting || body.trim().length === 0}
          aria-label={buttonAriaLabel}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {buttonLabel}
        </button>
      </div>
    </form>
  );
}

function CommentBadge({ state, compact = false }: { state: string; compact?: boolean }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 font-medium",
        compact ? "text-[10px]" : "text-[11px]",
        stateToneClassName(state),
      )}
    >
      {formatStateLabel(state)}
    </span>
  );
}

function anchorLabel(thread: CommentThreadSnapshot): string {
  switch (thread.anchor.kind) {
    case "cell":
      return "Cell";
    case "cell_range":
      return "Cell range";
    case "source_range":
      return "Source";
    case "output":
      return "Output";
    case "notebook":
    default:
      return "Document";
  }
}

function anchorLabelForDraft(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "source_range":
      return "source";
    case "cell":
      return "cell";
    case "cell_range":
      return "cell range";
    case "output":
      return "output";
    case "notebook":
    default:
      return "document";
  }
}

function sourceQuoteFromAnchor(anchor: CommentAnchor): string | null {
  return anchor.kind === "source_range" ? (anchor.exact_quote ?? null) : null;
}

function draftAutoFocusKey(target: NotebookCommentDraftTarget): string {
  return `${draftAnchorKey(target.anchor)}:${target.quote ?? ""}`;
}

function draftAnchorKey(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "cell":
      return `cell:${anchor.cell_id}`;
    case "source_range":
      return `source:${anchor.cell_id}:${anchor.start_line}:${anchor.start_column}:${anchor.end_line}:${anchor.end_column}`;
    case "output":
      return `output:${anchor.cell_id}:${anchor.execution_id ?? ""}:${anchor.output_id ?? ""}`;
    case "cell_range":
      return `cell_range:${anchor.start_cell_id}:${anchor.end_cell_id}`;
    case "notebook":
    default:
      return "notebook";
  }
}

function formatQuotePreview(quote: string | null | undefined): string | null {
  if (!quote) return null;
  if (quote.trim().length === 0) return null;
  if (quote.length <= 240) return quote;
  return `${quote.slice(0, 237)}...`;
}

function formatStateLabel(state: string): string {
  if (state.length === 0) return state;
  return state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, " ");
}

function formatActorLabel(actorLabel: string): string {
  if (actorLabel.startsWith("local:")) {
    const localLabel = actorLabel.slice("local:".length);
    const [principal, operator] = localLabel.split("/", 2);
    if (operator?.startsWith("desktop:")) {
      return principal ? `${principal} desktop` : "Local desktop";
    }
    if (operator?.startsWith("agent:")) {
      const agentName = operator.split(":")[1];
      return agentName ? `${principal} ${agentName}` : principal;
    }
    return principal || "Local";
  }

  if (actorLabel.startsWith("agent:nteract-mcp:")) {
    return "nteract MCP";
  }

  return actorLabel;
}

function stateToneClassName(state: string): string {
  switch (state) {
    case "accepted":
    case "open":
      return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/25 dark:text-emerald-300";
    case "pending":
      return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/25 dark:text-amber-300";
    case "rejected":
      return "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/25 dark:text-rose-300";
    case "resolved":
      return "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/25 dark:text-sky-300";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}
