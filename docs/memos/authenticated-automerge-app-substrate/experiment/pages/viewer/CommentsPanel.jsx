import { useEffect, useId, useRef, useState } from "react";
import { Check, MessageSquare, RotateCcw, X } from "lucide-react";
import { resolveCommentDraft } from "./comment-draft.mjs";
import "./comments.css";

function CommentAuthor({ author }) {
  const name = author?.displayName?.trim() || "Collaborator";
  const driver = author?.driver?.trim();
  const delegated = driver && driver.toLowerCase() !== "browser";
  return (
    <div className="message-author">
      <strong>{delegated ? driver : name}</strong>
      {delegated && <span className="muted">on behalf of {name}</span>}
    </div>
  );
}

export function CommentsPanel({
  open,
  session,
  threads,
  composer,
  target,
  onClose,
  onReveal,
  onSelect,
  onClearComposer,
}) {
  const dialog = useRef(null),
    composerElement = useRef(null),
    previousComposer = useRef(null),
    resolvedDisclosure = useRef(null);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 900px)").matches);
  const [drafts, setDrafts] = useState({});
  const [problem, setProblem] = useState("");
  const [changing, setChanging] = useState(null);
  useEffect(() => {
    const oldKey = previousComposer.current;
    const newKey = composer?.key;
    previousComposer.current = newKey;
    if (oldKey && newKey && oldKey !== newKey) {
      // Retargeting keeps the writer's body, with a separate key so an older
      // pending submission still cannot clear this composer.
      setDrafts((previous) => ({
        ...previous,
        [newKey]: previous[newKey] ?? previous[oldKey] ?? "",
      }));
    }
  }, [composer?.key]);
  useEffect(() => {
    const media = matchMedia("(max-width: 900px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    const focused = element.contains(document.activeElement) ? document.activeElement : null;
    const selection =
      focused?.tagName === "TEXTAREA"
        ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection]
        : null;
    // Keep the same forms mounted when the viewport changes. Only modality changes.
    if (element.open) element.close();
    if (open) {
      if (mobile) element.showModal();
      else element.show();
      if (focused?.isConnected && element.contains(focused)) {
        focused.focus({ preventScroll: true });
        if (selection) focused.setSelectionRange(...selection);
      }
    }
  }, [open, mobile]);
  useEffect(() => {
    if (!open || !composer?.key || target) return;
    const frame = requestAnimationFrame(() => {
      const textarea = composerElement.current?.querySelector("textarea");
      textarea?.focus({ preventScroll: true });
      composerElement.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, composer?.key, target]);
  useEffect(() => {
    if (!open || !target?.id) return;
    const frame = requestAnimationFrame(() => {
      const thread = dialog.current?.querySelector(`[data-thread-id="${CSS.escape(target.id)}"]`);
      const disclosure = thread?.closest("details");
      if (disclosure) disclosure.open = true;
      thread?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, target]);
  const changeDraft = (id, value) => setDrafts((previous) => ({ ...previous, [id]: value }));
  let quote = composer?.quote || "",
    draftProblem = "";
  if (composer) {
    try {
      quote =
        resolveCommentDraft(session.doc, composer.draft).selected_text?.replaceAll(
          "\ufffc",
          "\n",
        ) || "";
    } catch (error) {
      draftProblem = error.message;
    }
  }
  async function changeThread(thread) {
    setProblem("");
    setChanging(thread.id);
    const focused = document.activeElement;
    const openThreads = threads.filter((item) => item.state === "open");
    const index = openThreads.findIndex((item) => item.id === thread.id);
    const nextId =
      thread.state === "resolved"
        ? thread.id
        : (openThreads[index + 1] ?? openThreads[index - 1])?.id;
    try {
      await session.comment({
        action: thread.state === "open" ? "resolve" : "reopen",
        thread_id: thread.id,
      });
      requestAnimationFrame(() => {
        if (!dialog.current?.open) return;
        if (![focused, document.body, dialog.current].includes(document.activeElement)) return;
        const next =
          nextId &&
          dialog.current.querySelector(
            `.comments-body > [data-thread-id="${CSS.escape(nextId)}"] button`,
          );
        (
          next ||
          dialog.current.querySelector(".comments-body > .thread button") ||
          resolvedDisclosure.current?.querySelector("summary") ||
          dialog.current.querySelector(".comments-heading button")
        )?.focus({ preventScroll: true });
      });
    } catch (error) {
      setProblem(error.message);
    } finally {
      setChanging(null);
    }
  }
  function reveal(thread) {
    if (mobile) {
      onClose();
      requestAnimationFrame(() => onReveal(thread));
    } else onReveal(thread);
  }
  function renderThread(thread) {
    return (
      <CommentThread
        key={thread.id}
        thread={thread}
        session={session}
        selected={target?.id === thread.id}
        changing={changing === thread.id}
        value={drafts[thread.id] || ""}
        onChange={(body) => changeDraft(thread.id, body)}
        onReveal={() => reveal(thread)}
        onSelect={() => {
          if (target?.id !== thread.id) onSelect?.(thread.id);
        }}
        onChangeThread={() => changeThread(thread)}
      />
    );
  }
  const unresolved = threads.filter((thread) => thread.state === "open");
  const resolved = threads.filter((thread) => thread.state === "resolved");
  return (
    <dialog
      ref={dialog}
      id="page-comments"
      className={"comments" + (mobile ? " comments-sheet" : "")}
      aria-labelledby="comments-title"
      onClose={() => {
        if (!dialog.current.open && open) onClose();
      }}
      onClick={(event) => {
        if (mobile && event.target === dialog.current) onClose();
      }}
      onKeyDown={(event) => {
        if (!mobile && event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="comments-heading">
        <h2 id="comments-title">
          <MessageSquare size={18} aria-hidden="true" /> Comments
        </h2>
        <button className="icon-button" aria-label="Close comments" onClick={onClose}>
          <X size={19} aria-hidden="true" />
        </button>
      </div>
      <div className="comments-body">
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        {composer && session.canWrite && (
          <div className="comment-composer" ref={composerElement}>
            {quote && <blockquote className="composer-context">{quote}</blockquote>}
            {draftProblem && (
              <p className="error" role="alert">
                {draftProblem}. Select a passage and choose Comment again.
              </p>
            )}
            <CommentForm
              key={composer.key}
              label={
                composer.draft.target.kind === "selection"
                  ? "Comment on selection"
                  : "Comment on block"
              }
              value={drafts[composer.key] || ""}
              onChange={(body) => changeDraft(composer.key, body)}
              disabled={Boolean(draftProblem)}
              submit={(body) => {
                // No await between resolving the surviving cursors and creating the comment.
                const target = resolveCommentDraft(session.doc, composer.draft);
                return session.comment({ ...target, action: "add", body });
              }}
              onSuccess={() => onClearComposer(composer.key)}
              onCancel={() => {
                changeDraft(composer.key, "");
                onClearComposer(composer.key);
              }}
            />
          </div>
        )}
        {!unresolved.length && (
          <p className="muted comments-empty">
            {threads.length
              ? "All caught up."
              : session.canWrite
                ? "No comments yet. Select text to add one."
                : "No comments yet."}
          </p>
        )}
        {unresolved.map(renderThread)}
        {resolved.length > 0 && (
          <details className="resolved-threads" ref={resolvedDisclosure}>
            <summary>Resolved ({resolved.length})</summary>
            {resolved.map(renderThread)}
          </details>
        )}
      </div>
    </dialog>
  );
}

function CommentThread({
  thread,
  session,
  selected,
  changing,
  value,
  onChange,
  onReveal,
  onSelect,
  onChangeThread,
}) {
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [pending, setPending] = useState(false);
  const replyButton = useRef(null),
    form = useRef(null),
    pointerFocus = useRef(false);
  const repliesId = useId();
  const messages = thread.messages.filter((message) => !message.deletedAt);
  const [first, ...replies] = messages;
  const blockId =
    thread.target.kind === "selection" ? thread.target.anchor.blockId : thread.target.blockId;
  const blockSurvives = Object.hasOwn(session.doc.blocks, blockId);
  useEffect(() => {
    if (!session.canWrite) setPending(false);
  }, [session.canWrite]);
  useEffect(() => {
    if (!replying) return;
    const frame = requestAnimationFrame(() =>
      form.current?.querySelector("textarea")?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [replying]);
  function hideReply(restoreFocus = true) {
    setReplying(false);
    if (restoreFocus)
      requestAnimationFrame(() => replyButton.current?.focus({ preventScroll: true }));
  }
  return (
    <section
      className={
        "thread" +
        (thread.state === "resolved" ? " resolved" : "") +
        (selected ? " thread-active" : "")
      }
      data-thread-id={thread.id}
      aria-label="Comment thread"
      onPointerDownCapture={() => {
        pointerFocus.current = true;
      }}
      onPointerUpCapture={() => {
        pointerFocus.current = false;
      }}
      onPointerCancelCapture={() => {
        pointerFocus.current = false;
      }}
      onKeyDownCapture={() => {
        pointerFocus.current = false;
      }}
      onFocusCapture={() => {
        // Expanding a quote on pointer focus moves its controls before the click.
        // Keyboard focus can reveal immediately; pointer selection waits for click.
        if (!pointerFocus.current) onSelect();
      }}
      onClickCapture={() => {
        pointerFocus.current = false;
        onSelect();
      }}
    >
      {thread.selectionContext?.text ? (
        <button className="quote" onClick={onReveal} title="Show passage">
          {thread.selectionContext.text}
        </button>
      ) : blockSurvives &&
        (thread.target.kind === "block" || thread.selectionContext?.status === "detached") ? (
        <button className="quote" onClick={onReveal}>
          Show block
        </button>
      ) : null}
      {thread.selectionContext?.status === "detached" && (
        <p className="muted thread-detached">Passage removed</p>
      )}
      <div className="thread-heading">
        {first && <CommentAuthor author={first.author} />}
        {session.canWrite && (
          <button
            className="icon-button thread-state-action"
            aria-label={thread.state === "open" ? "Resolve" : "Reopen"}
            title={thread.state === "open" ? "Resolve thread" : "Reopen thread"}
            disabled={changing || pending}
            onClick={onChangeThread}
          >
            {thread.state === "open" ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <RotateCcw size={16} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      {first && (
        <div className="message">
          <p>{first.body}</p>
        </div>
      )}
      <div className="thread-conversation-actions">
        {replies.length > 0 && (
          <button
            type="button"
            className="subtle-button thread-replies-toggle"
            aria-expanded={repliesExpanded}
            aria-controls={repliesId}
            onClick={() => setRepliesExpanded((value) => !value)}
          >
            {repliesExpanded ? "Hide " : ""}
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </button>
        )}
        {session.canWrite && thread.state === "open" && (
          <button
            ref={replyButton}
            type="button"
            className="subtle-button thread-reply-button"
            hidden={replying}
            onClick={() => setReplying(true)}
          >
            {value ? "Continue reply" : "Reply"}
          </button>
        )}
      </div>
      <div id={repliesId} className="thread-replies" hidden={!repliesExpanded}>
        {replies.map((message) => (
          <div className="message" key={message.id}>
            <CommentAuthor author={message.author} />
            <p>{message.body}</p>
          </div>
        ))}
      </div>
      {session.canWrite && thread.state === "open" && (
        <div ref={form} hidden={!replying}>
          <CommentForm
            label="Reply"
            compact
            value={value}
            onChange={onChange}
            submit={(body) => session.comment({ action: "reply", thread_id: thread.id, body })}
            onBusyChange={setPending}
            onSuccess={() => {
              const restoreFocus = form.current?.contains(document.activeElement);
              setRepliesExpanded(true);
              hideReply(restoreFocus);
            }}
            onCancel={() => hideReply()}
            cancelLabel="Hide reply"
          />
        </div>
      )}
    </section>
  );
}

function CommentForm({
  label,
  value,
  onChange,
  submit,
  disabled = false,
  onSuccess,
  onCancel,
  compact = false,
  cancelLabel = "Cancel",
  onBusyChange,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      className={compact ? "comment-reply-form" : undefined}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || disabled || !value.trim()) return;
        setBusy(true);
        onBusyChange?.(true);
        setError("");
        try {
          await submit(value);
          if (!mounted.current) return;
          onChange("");
          onSuccess?.();
        } catch (error) {
          if (mounted.current) setError(error.message);
        } finally {
          if (mounted.current) {
            setBusy(false);
            onBusyChange?.(false);
          }
        }
      }}
    >
      <label>
        <span className={compact ? "sr-only" : undefined}>{label}</span>
        <textarea
          placeholder={compact ? "Write a reply…" : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={2}
          maxLength={16000}
          disabled={busy}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="comment-form-actions">
        <button className="primary" disabled={busy || disabled || !value.trim()}>
          Send
        </button>
        {onCancel && (
          <button type="button" className="subtle-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
        )}
      </div>
    </form>
  );
}
