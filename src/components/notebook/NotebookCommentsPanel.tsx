import {
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  MessageSquare,
  RotateCcw,
  X,
} from "lucide-react";
import { actorInitials, onBehalfOfPhrase } from "runtimed";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
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
import { AgentBrandMark } from "@/components/comments/agent-brand-mark";
import { ProjectedMarkdownView } from "../markdown/ProjectedMarkdownView";
import { useCellProjectionVersion } from "./state/cell-store";

type SourceRangeCommentAnchor = Extract<CommentAnchor, { kind: "source_range" }>;

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
  /** Brand slug of the agent product (`claude-code`), for its mark. */
  agentSlug?: string | null;
  /** Principal the agent is acting for, when operating on someone's behalf. */
  onBehalfOf?: string | null;
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
  /**
   * Rendered display quote for source-range anchors when the host can resolve
   * the live cell projection. Falls back to the anchor's exact quote.
   */
  resolveSourceQuote?: (anchor: SourceRangeCommentAnchor) => string | null | undefined;
  /** Live repaired source position for ordering moved source anchors. */
  resolveSourcePosition?: (
    anchor: SourceRangeCommentAnchor,
  ) => { line: number; column: number } | null | undefined;
  /**
   * Ordered notebook cell IDs, used to sort threads by the position of the
   * content they reference. Without it, threads keep their projection order.
   */
  cellIds?: readonly string[];
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
  resolveSourceQuote,
  resolveSourcePosition,
  cellIds,
  focusedThreadId = null,
  focusNonce = 0,
}: NotebookCommentsPanelProps) {
  const threads = projection?.threads ?? [];
  useCellProjectionVersion(
    threads.flatMap((thread) =>
      thread.anchor.kind === "source_range" ? [thread.anchor.cell_id] : [],
    ),
  );
  const labeledThreads = labelCommentThreads(
    sortCommentThreadsByNotebookPosition(threads, cellIds, resolveSourcePosition),
  );
  const openThreads = labeledThreads.filter(({ thread }) => thread.status !== "resolved");
  const resolvedThreads = labeledThreads.filter(({ thread }) => thread.status === "resolved");
  const [showResolved, setShowResolved] = useState(false);

  // Reveal resolved threads when the focus target is one of them, so a click
  // on a resolved thread's highlight can scroll to it.
  const focusedIsResolved = resolvedThreads.some(({ thread }) => thread.id === focusedThreadId);
  useEffect(() => {
    if (focusedIsResolved) setShowResolved(true);
  }, [focusedIsResolved, focusNonce]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  // Reply composers are only mounted for the selected thread. Keep drafts at
  // panel scope so moving between threads never throws away unsent work.
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  // Autofocus the reply box only when the reader selects a thread inside the
  // panel. A notebook-driven focus must not pull the caret out of the editor.
  const [autoFocusReplyThreadId, setAutoFocusReplyThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusedThreadId) return;
    setSelectedThreadId(focusedThreadId);
    setAutoFocusReplyThreadId(null);
  }, [focusedThreadId, focusNonce]);
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
      onSelect={() => {
        setSelectedThreadId(thread.id);
        setAutoFocusReplyThreadId(thread.id);
      }}
      replyDraft={replyDrafts[thread.id] ?? ""}
      onReplyDraftChange={(body) => {
        setReplyDrafts((current) => ({ ...current, [thread.id]: body }));
      }}
      onCancelReply={() => {
        setReplyDrafts((current) => ({ ...current, [thread.id]: "" }));
        setSelectedThreadId((current) => (current === thread.id ? null : current));
        setAutoFocusReplyThreadId((current) => (current === thread.id ? null : current));
      }}
      resolveCommentAuthor={resolveCommentAuthor}
      resolveSourceLanguage={resolveSourceLanguage}
      resolveSourceQuote={resolveSourceQuote}
      focused={thread.id === focusedThreadId}
      selected={thread.id === selectedThreadId}
      autoFocusReply={thread.id === autoFocusReplyThreadId}
      focusNonce={focusNonce}
    />
  );

  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="notebook-comments-panel">
      <div
        className="min-h-0 flex-1 overflow-y-auto pr-0"
        data-testid="notebook-comments-thread-scroll"
      >
        <div className="space-y-1 pb-0">
          {statusMessage ? (
            <div
              className="rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground"
              role="status"
            >
              {statusMessage}
            </div>
          ) : null}
          {errorMessage ? (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive"
              role="alert"
            >
              {errorMessage}
            </div>
          ) : null}

          {projection && threads.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center">
              <MessageSquare className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-xs font-medium text-foreground">No discussions yet</span>
              <span className="max-w-56 text-xs leading-4 text-muted-foreground">
                Select code or an output to comment on it, or start a discussion below.
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              {openThreads.length > 0 ? (
                <ol className="space-y-1.5">{openThreads.map(renderThread)}</ol>
              ) : resolvedThreads.length > 0 ? (
                <p className="px-1 py-3 text-center text-xs text-muted-foreground">
                  No open comments.
                </p>
              ) : null}

              {resolvedThreads.length > 0 ? (
                <div className="space-y-1.5 border-t pt-2">
                  <button
                    type="button"
                    onClick={() => setShowResolved((value) => !value)}
                    aria-expanded={showResolved}
                    className="flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showResolved ? (
                      <ChevronDown className="size-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="size-3.5" aria-hidden="true" />
                    )}
                    {showResolved ? "Hide" : "Show"} resolved ({resolvedThreads.length})
                  </button>
                  {showResolved ? (
                    <ol className="space-y-1.5">{resolvedThreads.map(renderThread)}</ol>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div
        className="shrink-0 space-y-1.5 border-t bg-background pt-2"
        data-testid="notebook-comments-composer-dock"
      >
        {draftTarget ? (
          <CommentDraftTargetView
            target={draftTarget}
            onClear={onClearDraftTarget}
            resolveSourceQuote={resolveSourceQuote}
          />
        ) : null}

        <CommentComposer
          ariaLabel={
            draftTarget
              ? `New ${anchorLabelForDraft(draftTarget.anchor)} comment`
              : "Add a comment on the document"
          }
          submitAriaLabel="Add comment"
          disabled={!canCreate}
          autoFocusKey={draftTarget ? draftAutoFocusKey(draftTarget) : "document"}
          placeholder={
            draftTarget
              ? `Add a ${anchorLabelForDraft(draftTarget.anchor)} comment`
              : "Add to the discussion"
          }
          compact={!draftTarget}
          onSubmit={onCreateThread}
        />
      </div>
    </section>
  );
}

function CommentDraftTargetView({
  target,
  onClear,
  resolveSourceQuote,
}: {
  target: NotebookCommentDraftTarget;
  onClear?: () => void;
  resolveSourceQuote?: (anchor: SourceRangeCommentAnchor) => string | null | undefined;
}) {
  const quote = formatQuotePreview(
    target.quote ?? sourceQuoteFromAnchor(target.anchor, resolveSourceQuote),
  );

  return (
    <div
      className="rounded-md border bg-muted/25 px-2.5 py-1.5 text-sm"
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
  onSelect,
  replyDraft,
  onReplyDraftChange,
  onCancelReply,
  resolveCommentAuthor,
  resolveSourceLanguage,
  resolveSourceQuote,
  focused,
  selected,
  autoFocusReply,
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
  onSelect?: () => void;
  replyDraft: string;
  onReplyDraftChange: (body: string) => void;
  onCancelReply: () => void;
  resolveCommentAuthor?: (actorLabel: string) => CommentAuthor;
  resolveSourceLanguage?: (cellId: string) => string | undefined;
  resolveSourceQuote?: (anchor: SourceRangeCommentAnchor) => string | null | undefined;
  focused?: boolean;
  /** Standing selection: the thread the reader is currently working in. */
  selected?: boolean;
  /** Place the caret in the reply box, set only for panel-driven selection. */
  autoFocusReply?: boolean;
  focusNonce?: number;
}) {
  const itemRef = useRef<HTMLLIElement>(null);
  const [flashing, setFlashing] = useState(false);
  // On a focus request for this thread, scroll it into view and flash softly.
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

  const quote = sourceQuoteFromAnchor(thread.anchor, resolveSourceQuote);
  const threadAuthor = thread.created_by_actor_label
    ? resolveCommentAuthor?.(thread.created_by_actor_label)
    : undefined;
  const canShowCell = Boolean(commentThreadTargetCellId(thread) && onFocusThreadAnchor);
  // Document-level threads carry no anchor context, so they show no header and
  // read as a plain conversation; cell/output threads without a quote keep their
  // label.
  const showAnchorLabel = !quote && thread.anchor.kind !== "notebook";

  // The quote sits inside the opening comment, under its author line, so the
  // reader sees who spoke before what they were speaking about.
  const sourceQuote = quote ? (
    <CommentSourceQuote
      quote={quote}
      language={
        resolveSourceLanguage
          ? resolveSourceLanguage(commentThreadTargetCellId(thread) ?? "")
          : undefined
      }
      color={threadAuthor?.color}
    />
  ) : null;
  return (
    <li
      ref={itemRef}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group relative rounded-md bg-card px-2 py-1.5 transition-all duration-200 hover:border-border",
        thread.status === "resolved" && "border-dashed bg-muted/20 opacity-80",
        !selected && "hover:bg-muted/40",
        selected &&
          "bg-[color-mix(in_srgb,var(--sev-info,var(--ring))_8%,transparent)] opacity-100 hover:bg-[color-mix(in_srgb,var(--sev-info,var(--ring))_12%,transparent)]",
        flashing && "bg-primary/5 hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={handleStatusAction}
        disabled={statusAction.disabled || statusSubmitting}
        aria-label={statusAction.ariaLabel}
        title={statusAction.label}
        className="absolute right-1 top-1 inline-grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <StatusIcon className="size-3.5" aria-hidden="true" />
      </button>
      <div className="space-y-1.5 pr-6">
        {showAnchorLabel ? (
          <div className="text-xs text-muted-foreground">{anchorLabel(thread)}</div>
        ) : null}

        <div className="space-y-2">
          {thread.messages.map((message, index) => (
            <CommentMessage
              key={message.id}
              message={message}
              isReply={index > 0}
              resolveCommentAuthor={resolveCommentAuthor}
              beforeBody={index === 0 ? sourceQuote : null}
            />
          ))}
          {thread.status === "resolved" ? (
            <CommentResolutionReceipt thread={thread} resolveCommentAuthor={resolveCommentAuthor} />
          ) : null}
        </div>

        {canShowCell || (canReply && !selected) ? (
          <div className="flex flex-wrap items-center gap-2">
            {canShowCell ? (
              <button
                type="button"
                onClick={() => onFocusThreadAnchor?.(thread)}
                aria-label={`Show cell for ${threadLabel}`}
                className="inline-flex items-center text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Show cell
              </button>
            ) : null}
            {canReply && !selected ? (
              <button
                type="button"
                onClick={onSelect}
                aria-label={`Reply to ${threadLabel}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <CornerDownRight className="size-3.5" aria-hidden="true" />
                Reply
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {canReply && selected ? (
        <div className="mt-1.5">
          <CommentComposer
            ariaLabel={`Reply to ${threadLabel}`}
            submitAriaLabel={`Submit reply to ${threadLabel}`}
            disabled={!canReply}
            autoFocusKey={autoFocusReply ? `${thread.id}:reply` : null}
            placeholder={thread.status === "resolved" ? "Reply to reopen…" : "Reply…"}
            compact
            value={replyDraft}
            onValueChange={onReplyDraftChange}
            onEscape={onCancelReply}
            onSubmit={onReplyThread ? (body) => onReplyThread(thread.id, body) : undefined}
          />
        </div>
      ) : null}
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
      ? `${resolverName} ${onBehalfOfPhrase(author.onBehalfOf)}`
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
  isReply = false,
  resolveCommentAuthor,
  beforeBody = null,
}: {
  message: CommentMessageSnapshot;
  /** Indent and rule-mark messages after a thread's opening comment. */
  isReply?: boolean;
  resolveCommentAuthor?: (actorLabel: string) => CommentAuthor;
  /** Anchor context (source quote) shown between the author line and the body. */
  beforeBody?: ReactNode;
}) {
  const author: CommentAuthor | null = message.created_by_actor_label
    ? (resolveCommentAuthor?.(message.created_by_actor_label) ?? {
        displayName: formatActorLabel(message.created_by_actor_label),
      })
    : null;

  return (
    <article
      className={cn("flex gap-2", isReply && "ml-2 border-l border-border pl-2")}
      data-comment-reply={isReply ? "true" : undefined}
    >
      {author ? (
        <CommentAuthorAvatar author={author} />
      ) : (
        <div className="mt-0.5 size-5 shrink-0 rounded-full bg-muted" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span
            className="text-xs font-semibold text-foreground"
            title={message.created_by_actor_label ?? undefined}
          >
            {author?.displayName ?? "Unknown"}
          </span>
          {author?.isAgent && author.onBehalfOf ? (
            // The agent is the author; the principal it acts for belongs in the name
            // line, spelled out, so the comment reads as accountable to a person.
            <span className="text-[10px] text-muted-foreground">
              {onBehalfOfPhrase(author.onBehalfOf)}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {formatRelativeTime(message.created_at)}
          </span>
        </div>
        {beforeBody ? <div className="mt-2 text-muted-foreground">{beforeBody}</div> : null}
        <CommentBody body={message.body} />
      </div>
    </article>
  );
}

function CommentAuthorAvatar({ author }: { author: CommentAuthor }) {
  // One avatar per message: the author's. An agent wears its own brand mark, and
  // the person it acts for is named in the line beside it rather than badged onto
  // the agent's face, so nothing competes with the author of the comment.
  return (
    <div
      className="mt-0.5 flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full text-[9px] font-semibold text-white"
      style={{ backgroundColor: author.color ?? "hsl(var(--muted-foreground))" }}
      aria-hidden="true"
    >
      {author.isAgent ? (
        <AgentBrandMark slug={author.agentSlug} className="size-3.5" />
      ) : author.imageUrl ? (
        <img className="size-full rounded-full object-cover" src={author.imageUrl} alt="" />
      ) : (
        actorInitials(author.displayName)
      )}
    </div>
  );
}

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
      className="block min-w-0 flex-1 truncate border-l-2 pl-2 font-mono text-xs"
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
      <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.45] text-foreground">
        {body}
      </p>
    );
  }
  return <ProjectedMarkdownView plan={plan} className="text-[13px] leading-[1.45]" />;
}

function CommentComposer({
  ariaLabel,
  submitAriaLabel,
  disabled,
  autoFocusKey = null,
  placeholder,
  compact = false,
  value,
  onValueChange,
  onEscape,
  onSubmit,
}: {
  ariaLabel: string;
  submitAriaLabel: string;
  disabled: boolean;
  autoFocusKey?: string | null;
  placeholder: string;
  /** Collapse to a single line until focused or non-empty (used for replies). */
  compact?: boolean;
  value?: string;
  onValueChange?: (body: string) => void;
  onEscape?: () => void;
  onSubmit?: (body: string) => void | Promise<void>;
}) {
  const [internalBody, setInternalBody] = useState("");
  const body = value ?? internalBody;
  const setBody = onValueChange ?? setInternalBody;
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Collapsed only while compact, blurred, empty, and idle.
  const expanded = !compact || focused || submitting || body.length > 0;
  const canSubmit = !disabled && !submitting && body.trim().length > 0 && Boolean(onSubmit);

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

  const submitBody = async () => {
    const trimmed = body.trim();
    if (!trimmed || disabled || submitting || !onSubmit) return;
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

  const handleBlur = () => {
    setFocused(false);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitBody();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setBody("");
      setFocused(false);
      textareaRef.current?.blur();
      onEscape?.();
      return;
    }

    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void submitBody();
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="relative">
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          value={body}
          disabled={disabled || submitting}
          placeholder={placeholder}
          onChange={(event) => setBody(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          rows={expanded ? 2 : 1}
          className={cn(
            "block w-full border bg-background pl-2.5 pr-8 text-[13px] leading-5",
            expanded
              ? "min-h-16 resize-y rounded-md py-1.5"
              : "min-h-9 resize-none rounded-full py-1.5",
            "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            (disabled || submitting) && "cursor-not-allowed opacity-60",
          )}
        />
        <button
          type="submit"
          disabled={!canSubmit}
          aria-label={submitAriaLabel}
          title={`${submitAriaLabel} (⌘↵)`}
          style={{
            background: "var(--comment-author-color, var(--primary, #2563eb))",
            color: "var(--comment-author-contrast, #ffffff)",
          }}
          className={cn(
            "absolute bottom-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-full transition-opacity",
            !canSubmit && "cursor-not-allowed opacity-40",
          )}
        >
          <ArrowUp className="size-3.5" aria-hidden="true" />
        </button>
      </div>
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

function sourceQuoteFromAnchor(
  anchor: CommentAnchor,
  resolveSourceQuote?: (anchor: SourceRangeCommentAnchor) => string | null | undefined,
): string | null {
  if (anchor.kind !== "source_range") return null;
  return resolveSourceQuote?.(anchor) ?? anchor.exact_quote ?? null;
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

export function sortCommentThreadsByNotebookPosition(
  threads: readonly CommentThreadSnapshot[],
  cellIds?: readonly string[],
  resolveSourcePosition?: (
    anchor: SourceRangeCommentAnchor,
  ) => { line: number; column: number } | null | undefined,
): CommentThreadSnapshot[] {
  if (!cellIds || cellIds.length === 0) return [...threads];

  const cellIndexById = new Map(cellIds.map((cellId, index) => [cellId, index]));
  const keyed = threads.map((thread, index) => ({
    thread,
    index,
    key: commentThreadOrderKey(thread, cellIndexById, resolveSourcePosition),
  }));

  keyed.sort((left, right) => {
    for (let part = 0; part < left.key.length; part++) {
      const delta = left.key[part]! - right.key[part]!;
      if (delta !== 0) return delta;
    }
    return left.index - right.index;
  });

  return keyed.map(({ thread }) => thread);
}

function commentThreadOrderKey(
  thread: CommentThreadSnapshot,
  cellIndexById: ReadonlyMap<string, number>,
  resolveSourcePosition?: (
    anchor: SourceRangeCommentAnchor,
  ) => { line: number; column: number } | null | undefined,
): number[] {
  const { anchor } = thread;
  if (anchor.kind === "notebook") return [2, 0, 0, 0, 0];

  const cellId = commentThreadTargetCellId(thread);
  const cellIndex = cellId === null ? undefined : cellIndexById.get(cellId);
  if (cellIndex === undefined) return [1, 0, 0, 0, 0];

  const withinCell = anchor.kind === "output" ? 2 : anchor.kind === "source_range" ? 1 : 0;
  const livePosition = anchor.kind === "source_range" ? resolveSourcePosition?.(anchor) : undefined;
  const line = anchor.kind === "source_range" ? (livePosition?.line ?? anchor.start_line) : 0;
  const column = anchor.kind === "source_range" ? (livePosition?.column ?? anchor.start_column) : 0;
  return [0, cellIndex, withinCell, line, column];
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
