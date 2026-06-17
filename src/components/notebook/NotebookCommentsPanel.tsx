import { CheckCircle2, MessageSquare, Plus, RotateCcw, Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { CommentMessageSnapshot, CommentThreadSnapshot, CommentsProjection } from "runtimed";
import { cn } from "@/lib/utils";

export interface NotebookCommentsPanelProps {
  projection: CommentsProjection | null;
  readOnly?: boolean;
  statusMessage?: string | null;
  errorMessage?: string | null;
  onCreateThread?: (body: string) => void | Promise<void>;
  onReplyThread?: (threadId: string, body: string) => void | Promise<void>;
  onResolveThread?: (threadId: string) => void | Promise<void>;
  onReopenThread?: (threadId: string) => void | Promise<void>;
}

export function NotebookCommentsPanel({
  projection,
  readOnly = false,
  statusMessage = null,
  errorMessage = null,
  onCreateThread,
  onReplyThread,
  onResolveThread,
  onReopenThread,
}: NotebookCommentsPanelProps) {
  const threads = (projection?.threads ?? []).filter((thread) => thread.anchor.kind === "notebook");
  const canCreate = !readOnly && Boolean(onCreateThread);
  const canReply = !readOnly && Boolean(onReplyThread);
  const canUpdateStatus = !readOnly && (Boolean(onResolveThread) || Boolean(onReopenThread));

  return (
    <section className="flex min-h-0 flex-col gap-3" data-testid="notebook-comments-panel">
      {statusMessage ? (
        <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {statusMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <CommentComposer
        ariaLabel="New document comment"
        buttonLabel="Add comment"
        icon="plus"
        disabled={!canCreate}
        placeholder="Add a document comment"
        onSubmit={onCreateThread}
      />

      {threads.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          <MessageSquare className="size-4" aria-hidden="true" />
          <span>No comments yet.</span>
        </div>
      ) : (
        <ol className="space-y-3">
          {threads.map((thread) => (
            <CommentThreadItem
              key={thread.id}
              thread={thread}
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

function CommentThreadItem({
  thread,
  canReply,
  canUpdateStatus,
  onReplyThread,
  onResolveThread,
  onReopenThread,
}: {
  thread: CommentThreadSnapshot;
  canReply: boolean;
  canUpdateStatus: boolean;
  onReplyThread?: (threadId: string, body: string) => void | Promise<void>;
  onResolveThread?: (threadId: string) => void | Promise<void>;
  onReopenThread?: (threadId: string) => void | Promise<void>;
}) {
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const statusActionEnabled = canUpdateStatus && thread.mutation_state === "accepted";
  const statusAction =
    thread.status === "resolved"
      ? {
          label: "Reopen",
          icon: RotateCcw,
          onClick: () => onReopenThread?.(thread.id),
          disabled: !statusActionEnabled || !onReopenThread,
        }
      : {
          label: "Resolve",
          icon: CheckCircle2,
          onClick: () => onResolveThread?.(thread.id),
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
            <div className="text-xs font-medium text-muted-foreground">{anchorLabel(thread)}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <CommentBadge state={thread.status} />
              {thread.mutation_state !== "accepted" ? (
                <CommentBadge state={thread.mutation_state} />
              ) : null}
            </div>
          </div>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {thread.messages.length}
          </span>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleStatusAction}
            disabled={statusAction.disabled || statusSubmitting}
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
          ariaLabel={`Reply to ${thread.id}`}
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

function CommentComposer({
  ariaLabel,
  buttonLabel,
  icon,
  disabled,
  placeholder,
  onSubmit,
}: {
  ariaLabel: string;
  buttonLabel: string;
  icon: "plus" | "send";
  disabled: boolean;
  placeholder: string;
  onSubmit?: (body: string) => void | Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const Icon = icon === "plus" ? Plus : Send;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || disabled || !onSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      setBody("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-2" onSubmit={handleSubmit}>
      <textarea
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
      return `Cell ${thread.anchor.cell_id}`;
    case "cell_range":
      return `Cells ${thread.anchor.start_cell_id} to ${thread.anchor.end_cell_id}`;
    case "source_range":
      return `Source ${thread.anchor.cell_id}`;
    case "output":
      return `Output ${thread.anchor.cell_id}`;
    case "notebook":
    default:
      return "Document";
  }
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
