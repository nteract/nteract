import { useEffect, useRef, useState } from "react";
import { Check, MessageSquare, RotateCcw, X } from "lucide-react";
import { resolveCommentDraft } from "./comment-draft.mjs";

export function CommentsPanel({
  open,
  session,
  threads,
  composer,
  target,
  onClose,
  onReveal,
  onClearComposer,
}) {
  const dialog = useRef(null),
    composerElement = useRef(null),
    previousComposer = useRef(null);
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
    // Keep the same forms mounted when the viewport changes. Only modality changes.
    if (element.open) element.close();
    if (open) {
      if (mobile) element.showModal();
      else element.show();
    }
  }, [open, mobile]);
  useEffect(() => {
    if (!open || !composer?.key) return;
    const frame = requestAnimationFrame(() => {
      const textarea = composerElement.current?.querySelector("textarea");
      textarea?.focus({ preventScroll: true });
      composerElement.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, composer?.key]);
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
    try {
      await session.comment({
        action: thread.state === "open" ? "resolve" : "reopen",
        thread_id: thread.id,
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
    const blockId =
      thread.target.kind === "selection" ? thread.target.anchor.blockId : thread.target.blockId;
    const blockSurvives = Object.hasOwn(session.doc.blocks, blockId);
    return (
      <section
        className={
          "thread" +
          (thread.state === "resolved" ? " resolved" : "") +
          (target?.id === thread.id ? " thread-active" : "")
        }
        key={thread.id}
        aria-label="Comment thread"
      >
        {thread.selectionContext?.text ? (
          <button className="quote" onClick={() => reveal(thread)} title="Show passage">
            {thread.selectionContext.text}
          </button>
        ) : blockSurvives &&
          (thread.target.kind === "block" || thread.selectionContext?.status === "detached") ? (
          <button className="quote" onClick={() => reveal(thread)}>
            Show block
          </button>
        ) : null}
        {thread.selectionContext?.status === "detached" && <p className="muted">Passage removed</p>}
        {thread.messages.map((message) =>
          message.deletedAt ? null : (
            <div className="message" key={message.id}>
              <div className="message-author">
                <strong>{message.author?.displayName || "Collaborator"}</strong>
                {message.author?.driver && <span className="muted">{message.author.driver}</span>}
              </div>
              <p>{message.body}</p>
            </div>
          ),
        )}
        {session.canWrite && (
          <>
            <div className="thread-actions">
              <button
                className="subtle-button"
                disabled={changing === thread.id}
                onClick={() => changeThread(thread)}
              >
                {thread.state === "open" ? (
                  <Check size={15} aria-hidden="true" />
                ) : (
                  <RotateCcw size={15} aria-hidden="true" />
                )}
                {thread.state === "open" ? "Resolve" : "Reopen"}
              </button>
            </div>
            {thread.state === "open" && (
              <CommentForm
                label="Reply"
                value={drafts[thread.id] || ""}
                onChange={(body) => changeDraft(thread.id, body)}
                submit={(body) => session.comment({ action: "reply", thread_id: thread.id, body })}
              />
            )}
          </>
        )}
      </section>
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
            {threads.length ? "All caught up." : "No comments yet."}
          </p>
        )}
        {unresolved.map(renderThread)}
        {resolved.length > 0 && (
          <details className="resolved-threads">
            <summary>Resolved ({resolved.length})</summary>
            {resolved.map(renderThread)}
          </details>
        )}
      </div>
    </dialog>
  );
}

function CommentForm({ label, value, onChange, submit, disabled = false, onSuccess, onCancel }) {
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
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || disabled || !value.trim()) return;
        setBusy(true);
        setError("");
        try {
          await submit(value);
          if (!mounted.current) return;
          onChange("");
          onSuccess?.();
        } catch (error) {
          if (mounted.current) setError(error.message);
        } finally {
          if (mounted.current) setBusy(false);
        }
      }}
    >
      <label>
        {label}
        <textarea
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
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
