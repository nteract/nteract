import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  LocateFixed,
  MessageSquare,
  Plus,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import { actorInitials, onBehalfOfText } from "runtimed";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  CommentAnchor,
  CommentMessageSnapshot,
  CommentThreadSnapshot,
  CommentsProjection,
} from "./comment-types";
import { projectMarkdownPlan } from "../../lib/markdown-projection";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import { cn } from "@/lib/utils";
import { highlight } from "@/components/editor/static-highlight";
import { ProjectedMarkdownView } from "../markdown/ProjectedMarkdownView";

export interface NotebookCommentDraftTarget {
  anchor: CommentAnchor;
  quote?: string | null;
}

/** Rendered attribution for a comment author. */
export interface CommentAuthor {
  /** Display name (e.g. "Claude Code" or "kylekelley"). */
  displayName: string;
  /** Author color (hex), shared with cursors/attribution/highlights. */
  color?: string;
  /** Profile image URL when the host can resolve one for this author. */
  imageUrl?: string | null;
  /** True when the author is an AI agent rather than a person. */
  isAgent?: boolean;
  /** Principal the agent is acting for, when operating on someone's behalf. */
  onBehalfOf?: string | null;
  /** Color of the principal the agent acts for (for the on-behalf-of badge). */
  onBehalfOfColor?: string | null;
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
  onFocusThreadAnchor?: (thread: CommentThreadSnapshot) => void;
  /**
   * Resolve attribution for a comment author's actor label: display name,
   * color, whether it's an AI agent, and the principal it acts for. Falls back
   * to parsing the actor label when not provided.
   */
  resolveCommentAuthor?: (actorLabel: string) => CommentAuthor;
  /**
   * Language for syntax-highlighting a quoted source range, by anchored cell.
   * Returns undefined for cells whose quotes should not be code-highlighted
   * (e.g. markdown prose, raw cells).
   */
  resolveSourceLanguage?: (cellId: string) => string | undefined;
  /** Thread to scroll to and flash (e.g. after clicking its editor highlight). */
  focusedThreadId?: string | null;
  /** Bumped each focus request so repeat focuses of the same thread re-flash. */
  focusNonce?: number;
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
  onFocusThreadAnchor,
  resolveCommentAuthor,
  resolveSourceLanguage,
  focusedThreadId = null,
  focusNonce = 0,
}: NotebookCommentsPanelProps) {
  const threads = projection?.threads ?? [];
  const labeledThreads = labelCommentThreads(threads);
  const openThreads = labeledThreads.filter(({ thread }) => thread.status !== "resolved");
  const resolvedThreads = labeledThreads.filter(({ thread }) => thread.status === "resolved");
  const [showResolved, setShowResolved] = useState(false);

  // Reveal resolved threads when the focus target is one of them, so a click
  // on a resolved thread's highlight can scroll to it.
  const focusedIsResolved = resolvedThreads.some(({ thread }) => thread.id === focusedThreadId);
  useEffect(() => {
    if (focusedIsResolved) setShowResolved(true);
  }, [focusedIsResolved, focusNonce]);
  const canCreate = !readOnly && Boolean(onCreateThread);
  const canReply = !readOnly && Boolean(onReplyThread);
  const canUpdateStatus = !readOnly && (Boolean(onResolveThread) || Boolean(onReopenThread));

  const renderThread = ({
    thread,
    threadLabel,
  }: {
    thread: CommentThreadSnapshot;
    threadLabel: string;
  }) => (
    <CommentThreadItem
      key={thread.id}
      thread={thread}
      threadLabel={threadLabel}
      canReply={canReply}
      canUpdateStatus={canUpdateStatus}
      onReplyThread={onReplyThread}
      onResolveThread={onResolveThread}
      onReopenThread={onReopenThread}
      onFocusThreadAnchor={onFocusThreadAnchor}
      resolveCommentAuthor={resolveCommentAuthor}
      resolveSourceLanguage={resolveSourceLanguage}
      focused={thread.id === focusedThreadId}
      focusNonce={focusNonce}
    />
  );

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
        compact={!draftTarget}
        onSubmit={onCreateThread}
      />

      {projection && threads.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          <MessageSquare className="size-4" aria-hidden="true" />
          <span>No comments yet.</span>
        </div>
      ) : (
        <div className="space-y-3">
          {openThreads.length > 0 ? (
            <ol className="space-y-3">{openThreads.map(renderThread)}</ol>
          ) : resolvedThreads.length > 0 ? (
            <p className="px-1 py-4 text-center text-sm text-muted-foreground">No open comments.</p>
          ) : null}

          {resolvedThreads.length > 0 ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setShowResolved((value) => !value)}
                aria-expanded={showResolved}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {showResolved ? (
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                )}
                {showResolved ? "Hide" : "Show"} resolved ({resolvedThreads.length})
              </button>
              {showResolved ? (
                <ol className="space-y-3">{resolvedThreads.map(renderThread)}</ol>
              ) : null}
            </div>
          ) : null}
        </div>
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
  onFocusThreadAnchor,
  resolveCommentAuthor,
  resolveSourceLanguage,
  focused,
  focusNonce,
}: {
  thread: CommentThreadSnapshot;
  threadLabel: string;
  canReply: boolean;
  canUpdateStatus: boolean;
  onReplyThread?: (threadId: string, body: string) => void | Promise<void>;
  onResolveThread?: (threadId: string) => void | Promise<void>;
  onReopenThread?: (threadId: string) => void | Promise<void>;
  onFocusThreadAnchor?: (thread: CommentThreadSnapshot) => void;
  resolveCommentAuthor?: (actorLabel: string) => CommentAuthor;
  resolveSourceLanguage?: (cellId: string) => string | undefined;
  focused?: boolean;
  focusNonce?: number;
}) {
  const itemRef = useRef<HTMLLIElement>(null);
  const [flashing, setFlashing] = useState(false);
  // On a focus request for this thread, scroll it into view and flash a ring.
  useEffect(() => {
    if (!focused) return;
    itemRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 1100);
    return () => clearTimeout(timer);
  }, [focused, focusNonce]);
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const statusActionEnabled = canUpdateStatus;
  const statusAction =
    thread.status === "resolved"
      ? {
          label: "Re-open",
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

  const quote = sourceQuoteFromAnchor(thread.anchor);
  const threadAuthor = thread.created_by_actor_label
    ? resolveCommentAuthor?.(thread.created_by_actor_label)
    : undefined;
  const canShowCell = Boolean(commentThreadTargetCellId(thread) && onFocusThreadAnchor);

  return (
    <li
      ref={itemRef}
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow duration-700",
        thread.status === "resolved" && "border-border/70 bg-muted/10 shadow-none",
        flashing && "ring-2 ring-primary/60",
      )}
    >
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2">
          {quote ? (
            <CommentSourceQuote
              quote={quote}
              language={
                resolveSourceLanguage
                  ? resolveSourceLanguage(commentThreadTargetCellId(thread) ?? "")
                  : undefined
              }
              color={threadAuthor?.color}
            />
          ) : (
            <div className="min-w-0 flex-1 text-xs text-muted-foreground">
              {anchorLabel(thread)}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            {canShowCell ? (
              <button
                type="button"
                onClick={() => onFocusThreadAnchor?.(thread)}
                aria-label={`Show cell for ${threadLabel}`}
                title="Show cell"
                className="inline-grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <LocateFixed className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleStatusAction}
              disabled={statusAction.disabled || statusSubmitting}
              aria-label={statusAction.ariaLabel}
              title={statusAction.label}
              className="inline-grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <StatusIcon className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {thread.messages.map((message) => (
            <CommentMessage
              key={message.id}
              message={message}
              resolveCommentAuthor={resolveCommentAuthor}
            />
          ))}
          {thread.status === "resolved" ? (
            <CommentResolutionReceipt thread={thread} resolveCommentAuthor={resolveCommentAuthor} />
          ) : null}
        </div>

        <CommentComposer
          ariaLabel={`Reply to ${threadLabel}`}
          buttonAriaLabel={`Submit reply to ${threadLabel}`}
          buttonLabel="Reply"
          icon="send"
          disabled={!canReply}
          placeholder={thread.status === "resolved" ? "Reply to reopen…" : "Reply…"}
          compact
          onSubmit={onReplyThread ? (body) => onReplyThread(thread.id, body) : undefined}
        />
      </div>
    </li>
  );
}

function resolveThreadResolutionAuthor(
  thread: CommentThreadSnapshot,
  resolveCommentAuthor?: (actorLabel: string) => CommentAuthor,
): { actorLabel: string | null; author: CommentAuthor | null } {
  const actorLabel = thread.resolved_by_actor_label ?? thread.created_by_actor_label ?? null;
  return {
    actorLabel,
    author: actorLabel
      ? (resolveCommentAuthor?.(actorLabel) ?? { displayName: formatActorLabel(actorLabel) })
      : null,
  };
}

function CommentResolutionReceipt({
  thread,
  resolveCommentAuthor,
}: {
  thread: CommentThreadSnapshot;
  resolveCommentAuthor?: (actorLabel: string) => CommentAuthor;
}) {
  const { author } = resolveThreadResolutionAuthor(thread, resolveCommentAuthor);
  const resolvedTime = formatRelativeTime(thread.resolved_at);
  const resolverName = author?.displayName ?? "Someone";
  const resolverIdentity =
    author?.isAgent && author.onBehalfOf
      ? `${resolverName}${onBehalfOfText(author.onBehalfOf)}`
      : resolverName;
  const resolutionLabel = `${resolverIdentity} marked as resolved${resolvedTime ? ` · ${resolvedTime}` : ""}`;
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="comment-resolution-receipt"
      aria-label={resolutionLabel}
      title={resolutionLabel}
    >
      <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate" title={resolverIdentity}>
        {resolverIdentity}
      </span>
      <span className="shrink-0">marked as resolved</span>
      {resolvedTime ? <span className="shrink-0">· {resolvedTime}</span> : null}
    </div>
  );
}

function CommentMessage({
  message,
  resolveCommentAuthor,
}: {
  message: CommentMessageSnapshot;
  resolveCommentAuthor?: (actorLabel: string) => CommentAuthor;
}) {
  const author: CommentAuthor | null = message.created_by_actor_label
    ? (resolveCommentAuthor?.(message.created_by_actor_label) ?? {
        displayName: formatActorLabel(message.created_by_actor_label),
      })
    : null;

  return (
    <article className="flex gap-2.5">
      {author ? (
        <CommentAuthorAvatar author={author} />
      ) : (
        <div className="mt-0.5 size-5 shrink-0 rounded-full bg-muted" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span
            className="text-xs font-semibold text-foreground"
            title={message.created_by_actor_label ?? undefined}
          >
            {author?.displayName ?? "Unknown"}
          </span>
          {author?.isAgent && author.onBehalfOf ? (
            <span className="text-[10px] text-muted-foreground">
              ·{onBehalfOfText(author.onBehalfOf)}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {formatRelativeTime(message.created_at)}
          </span>
        </div>
        <CommentBody body={message.body} />
      </div>
    </article>
  );
}

function CommentAuthorAvatar({ author }: { author: CommentAuthor }) {
  const face = (
    <div
      className="flex size-5 items-center justify-center overflow-hidden rounded-full text-[9px] font-semibold text-white"
      style={{ backgroundColor: author.color ?? "hsl(var(--muted-foreground))" }}
    >
      {author.imageUrl ? (
        <img className="size-full rounded-full object-cover" src={author.imageUrl} alt="" />
      ) : author.isAgent ? (
        <Bot className="size-3" />
      ) : (
        actorInitials(author.displayName)
      )}
    </div>
  );

  // When an agent acts for someone, badge the principal in the corner,
  // tinted with the principal's own color.
  if (author.isAgent && author.onBehalfOf) {
    return (
      <div className="relative mt-0.5 size-5 shrink-0" aria-hidden="true">
        {face}
        <span
          className="absolute -bottom-1 -right-1 flex size-3 items-center justify-center rounded-full text-[6px] font-bold text-white ring-2 ring-card"
          style={{ backgroundColor: author.onBehalfOfColor ?? "hsl(var(--muted-foreground))" }}
          title={`${author.displayName}${onBehalfOfText(author.onBehalfOf)}`}
        >
          {actorInitials(author.onBehalfOf).slice(0, 1)}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-0.5 shrink-0" aria-hidden="true">
      {face}
    </div>
  );
}

/**
 * Render a comment body through the shared markdown engine so inline code,
 * emphasis, links, and lists match the rest of the app. The projector returns
 * a structured plan (never raw HTML), so this is safe by construction; falls
 * back to plain text when the projector is unavailable.
 */
/**
 * The selected source a thread is anchored to, rendered as a single-line,
 * syntax-highlighted snippet with a left bar tinted to the thread author's
 * color. Uses the same static highlighter as markdown code blocks.
 */
function CommentSourceQuote({
  quote,
  language,
  color,
}: {
  quote: string;
  language?: string;
  color?: string;
}) {
  const isDark = useDarkMode();
  const colorTheme = useColorTheme() === "cream" ? "cream" : "classic";
  const nodes = highlight(quote, language, isDark, colorTheme);
  return (
    <code
      className="min-w-0 flex-1 truncate border-l-2 pl-2 font-mono text-xs"
      style={{ borderColor: color ?? "hsl(var(--border))" }}
      data-testid="comment-thread-source-quote"
      title={quote}
    >
      {nodes}
    </code>
  );
}

function CommentBody({ body }: { body: string }) {
  const plan = projectMarkdownPlan(body);
  if (!plan) {
    return (
      <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground">{body}</p>
    );
  }
  return <ProjectedMarkdownView plan={plan} className="text-sm leading-5" />;
}

function CommentComposer({
  ariaLabel,
  buttonAriaLabel,
  buttonLabel,
  icon,
  disabled,
  autoFocusKey = null,
  placeholder,
  compact = false,
  onSubmit,
}: {
  ariaLabel: string;
  buttonAriaLabel?: string;
  buttonLabel: string;
  icon: "plus" | "send";
  disabled: boolean;
  autoFocusKey?: string | null;
  placeholder: string;
  /** Collapse to a single line until focused or non-empty (used for replies). */
  compact?: boolean;
  onSubmit?: (body: string) => void | Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const Icon = icon === "plus" ? Plus : Send;
  // Collapsed only while compact, blurred, empty, and idle.
  const expanded = !compact || focused || submitting || body.length > 0;

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
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        rows={expanded ? 3 : 1}
        className={cn(
          "w-full resize-y border bg-background px-3 text-sm leading-5",
          expanded ? "min-h-20 rounded-md py-2" : "min-h-0 resize-none rounded-full py-1.5",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
          (disabled || submitting) && "cursor-not-allowed opacity-60",
        )}
      />
      {expanded ? (
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
      ) : null}
    </form>
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

function commentThreadTargetCellId(thread: CommentThreadSnapshot): string | null {
  switch (thread.anchor.kind) {
    case "cell":
    case "source_range":
    case "output":
      return thread.anchor.cell_id;
    case "cell_range":
      return thread.anchor.start_cell_id;
    case "notebook":
    default:
      return thread.badge_cell_ids[0] ?? null;
  }
}

function labelCommentThreads(
  threads: readonly CommentThreadSnapshot[],
): Array<{ thread: CommentThreadSnapshot; threadLabel: string }> {
  const counts = new Map<string, number>();
  return threads.map((thread) => {
    const label = anchorLabel(thread);
    const count = (counts.get(label) ?? 0) + 1;
    counts.set(label, count);
    return {
      thread,
      threadLabel: `${label} comment ${count}`,
    };
  });
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

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
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
