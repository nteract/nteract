import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, MessageSquare, RotateCcw, X, Maximize2, Minimize2 } from "lucide-react";
import { resolveCommentDraft } from "./comment-draft.mjs";
import { reloadGate } from "./build-freshness.mjs";
import { hasDraftText } from "./comment-composer.mjs";
import { Store, useStore } from "./store.mjs";
import { COMMENTS_SHEET_QUERY } from "./comments-layout.mjs";
import { CommentRichText, CommentContent } from "./CommentRichText.jsx";
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

const NO_COMPOSER = new Store({ state: { name: "idle" }, composer: null, body: "" });

export function CommentsPanel({
  open,
  session,
  threads,
  composer,
  target,
  onClose,
  onReveal,
  onSelect,
}) {
  const dialog = useRef(null),
    resolvedDisclosure = useRef(null);
  // The inline composer (CommentPopover) owns new comments. The panel shows a
  // draft only after the popover closed with text in it.
  const draft = useStore(composer?.store ?? NO_COMPOSER);
  const keptDraft = draft.state.name === "dismissed" ? draft : null;
  const [mobile, setMobile] = useState(() => matchMedia(COMMENTS_SHEET_QUERY).matches);
  const [drafts, setDrafts] = useState({});
  const [expanded, setExpanded] = useState(false);
  const [visited, setVisited] = useState(open);
  // A modal sheet makes everything outside it inert, the inline composer
  // included. While the composer shows (open, sending, or reopened after a
  // failed send) the sheet stays non-modal under it; it turns modal once the
  // composer closes. Closing with text leaves the kept draft listed here.
  const composerShowing = draft.state.name === "open" || draft.state.name === "sending";
  const modal = mobile && !composerShowing;
  // At sheet width the composer covers this sheet, so keyboard focus must not
  // reach it: Tab could land on hidden controls, and Escape there would close
  // the panel instead of the composer. Beside the Page it stays usable.
  const inert = mobile && composerShowing;
  useEffect(() => {
    if (open) setVisited(true);
  }, [open]);
  const [problem, setProblem] = useState("");
  const [changing, setChanging] = useState(null);
  useEffect(() => {
    const media = matchMedia(COMMENTS_SHEET_QUERY);
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
    const browserSelection = document.getSelection();
    const richSelection =
      focused?.closest(".comment-rich-editor") && browserSelection?.rangeCount
        ? browserSelection.getRangeAt(0).cloneRange()
        : null;
    // Keep the same forms mounted when the viewport changes. Only modality changes.
    if (element.open) element.close();
    if (open) {
      if (modal) element.showModal();
      else element.show();
      if (focused?.isConnected && element.contains(focused)) {
        focused.focus({ preventScroll: true });
        if (selection) focused.setSelectionRange(...selection);
        if (richSelection?.startContainer.isConnected && richSelection.endContainer.isConnected) {
          browserSelection.removeAllRanges();
          browserSelection.addRange(richSelection);
        }
      }
    }
  }, [open, modal]);
  useLayoutEffect(() => {
    // Focus left inside an inert subtree is dropped to the body. Hand it to
    // the composer, whose sheet now owns the keyboard.
    if (!inert) return;
    const active = document.activeElement;
    if (dialog.current?.contains(active) || !active || active === document.body) composer?.focus();
  }, [inert, composer]);
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
  // Drafts exist only in local UI, so a reload asks about every draft that
  // still has a place on screen: the inline composer's draft (in the popover,
  // or here once dismissed) and a reply on any thread, open or resolved. Each
  // of those stays reachable to copy or discard.
  const unsent =
    (draft.composer && hasDraftText(draft.body)) || threads.some((t) => hasDraft(drafts[t.id]));
  const draftSource = useRef(null);
  useEffect(() => {
    const source = reloadGate.watchDrafts();
    draftSource.current = source;
    return () => {
      draftSource.current = null;
      source.stop();
    };
  }, []);
  useEffect(() => draftSource.current?.set(unsent), [unsent]);
  // Reply drafts live only here. A refusal reads them into the recovery
  // archive before this panel unmounts.
  const replyDrafts = useRef(null);
  replyDrafts.current = { drafts, threads };
  useEffect(
    () =>
      session.watchCommentDrafts?.(() =>
        replyDrafts.current.threads
          .filter((thread) => hasDraft(replyDrafts.current.drafts[thread.id]))
          .map((thread) => {
            const value = replyDrafts.current.drafts[thread.id];
            return {
              kind: "reply",
              thread_id: thread.id,
              body: value?.markdown ?? value,
              quote:
                thread.selectionContext?.status === "attached" ? thread.selectionContext.text : "",
            };
          }),
      ),
    [session],
  );
  const resolvedDraft = threads.some((t) => t.state === "resolved" && hasDraft(drafts[t.id]));
  useEffect(() => {
    if (resolvedDraft && resolvedDisclosure.current) resolvedDisclosure.current.open = true;
  }, [resolvedDraft, visited]);
  let quote = keptDraft?.composer.quote || "",
    draftProblem = "";
  if (keptDraft) {
    try {
      quote =
        resolveCommentDraft(session.doc, keptDraft.composer.draft).selected_text?.replaceAll(
          "\ufffc",
          "\n",
        ) || "";
    } catch (error) {
      draftProblem = error.message;
    }
  }
  function continueDraft() {
    if (mobile) {
      onClose();
      requestAnimationFrame(() => composer.reopen());
    } else composer.reopen();
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
      inert={inert}
      id="page-comments"
      className={"comments" + (mobile ? " comments-sheet" : expanded ? " comments-expanded" : "")}
      aria-labelledby="comments-title"
      onClose={() => {
        if (!dialog.current.open && open) onClose();
      }}
      onClick={(event) => {
        if (modal && event.target === dialog.current) onClose();
      }}
      onKeyDown={(event) => {
        if (!event.defaultPrevented && !modal && event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="comments-heading">
        <h2 id="comments-title">
          <MessageSquare size={18} aria-hidden="true" /> Comments
        </h2>
        {!mobile && (
          <button
            className="icon-button comments-expand"
            aria-label={expanded ? "Narrow comments" : "Expand comments"}
            title={expanded ? "Narrow comments" : "Expand comments"}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <Minimize2 size={17} aria-hidden="true" />
            ) : (
              <Maximize2 size={17} aria-hidden="true" />
            )}
          </button>
        )}
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
        {session.commentsUnavailable && (
          <p role="alert" className="error comments-unavailable">
            Comments couldn't load. You can still read the Page.{" "}
            <button type="button" className="subtle-button" onClick={() => session.retryComments()}>
              Try again
            </button>
          </p>
        )}
        {keptDraft && (
          <section className="comment-kept-draft" aria-label="Unsent comment">
            <p className="muted comment-kept-draft-label">Unsent comment</p>
            {quote && <blockquote className="composer-context">{quote}</blockquote>}
            {draftProblem && (
              <p className="error" role="alert">
                {draftProblem}. Copy the text, then select a passage and choose Comment again.
              </p>
            )}
            <p className="comment-kept-draft-text">{keptDraft.body?.markdown ?? keptDraft.body}</p>
            <div className="comment-form-actions">
              {session.canComment && !draftProblem && (
                <button type="button" className="primary" onClick={continueDraft}>
                  Continue
                </button>
              )}
              <button type="button" className="subtle-button" onClick={() => composer.cancel()}>
                Discard
              </button>
            </div>
          </section>
        )}
        {!unresolved.length && (
          <p className="muted comments-empty">
            {threads.length
              ? "All caught up."
              : session.canComment
                ? "No comments yet. Select text to add one."
                : "No comments yet."}
          </p>
        )}
        {(open || visited) && unresolved.map(renderThread)}
        {resolved.length > 0 && (
          <details className="resolved-threads" ref={resolvedDisclosure}>
            <summary>
              Resolved ({resolved.length}){resolvedDraft ? " · unsent reply" : ""}
            </summary>
            {(open || visited) && resolved.map(renderThread)}
          </details>
        )}
      </div>
    </dialog>
  );
}

const hasDraft = (value) => Boolean((value?.markdown ?? value)?.trim());

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
  const [replyStarted, setReplyStarted] = useState(false);
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
  const canReply = session.canComment && thread.state === "open";
  // A typed reply that can't be sent (edits paused, access lost, or the
  // thread resolved) stays visible, read-only, so it can be copied or
  // discarded. Reload counts it until then.
  const keptDraft = !canReply && hasDraft(value);
  useEffect(() => {
    if (!session.canComment) setPending(false);
  }, [session.canComment]);
  useEffect(() => {
    if (!replying) return;
    const frame = requestAnimationFrame(() =>
      form.current?.querySelector('[role="textbox"]')?.focus({ preventScroll: true }),
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
        {session.canComment && (
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
          <CommentContent message={first} source={session.commentMessage(thread.id, first.id)} />
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
        {canReply && (
          <button
            ref={replyButton}
            type="button"
            className="subtle-button thread-reply-button"
            hidden={replying}
            onClick={() => {
              setReplyStarted(true);
              setReplying(true);
            }}
          >
            {(value.markdown ?? value) ? "Continue reply" : "Reply"}
          </button>
        )}
      </div>
      <div id={repliesId} className="thread-replies" hidden={!repliesExpanded}>
        {replies.map((message) => (
          <div className="message" key={message.id}>
            <CommentAuthor author={message.author} />
            {repliesExpanded && (
              <CommentContent
                message={message}
                source={session.commentMessage(thread.id, message.id)}
              />
            )}
          </div>
        ))}
      </div>
      {((canReply && replyStarted) || keptDraft) && (
        <div ref={form} hidden={!replying && !keptDraft}>
          {keptDraft && <p className="muted thread-kept-draft">Unsent reply</p>}
          <CommentForm
            label="Reply"
            compact
            value={value}
            onChange={onChange}
            disabled={!canReply}
            images={{ pageId: session.pageId, canUpload: session.canComment && session.canWrite }}
            onDiscard={() => {
              onChange("");
              hideReply(!keptDraft);
            }}
            submit={(body, spans) =>
              session.comment(
                {
                  action: "reply",
                  thread_id: thread.id,
                  body,
                  body_format: "markdown",
                },
                spans,
              )
            }
            onBusyChange={setPending}
            onSuccess={() => {
              const restoreFocus = form.current?.contains(document.activeElement);
              setRepliesExpanded(true);
              hideReply(restoreFocus);
            }}
            onCancel={keptDraft ? undefined : () => hideReply()}
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
  onDiscard,
  images,
}) {
  const body = value.markdown ?? value;
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  useEffect(() => setCopied(false), [body]);
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
        if (busy || uploading || disabled || draftError || !body.trim()) return;
        setBusy(true);
        onBusyChange?.(true);
        setError("");
        try {
          await submit(body, value.spans);
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
      <div>
        <span className={compact ? "sr-only" : undefined}>{label}</span>
        <CommentRichText
          label={label}
          value={body}
          nativeSpans={value.spans}
          onChange={(markdown, spans) => onChange(spans ? { markdown, spans } : markdown)}
          onError={setDraftError}
          disabled={busy || disabled}
          images={images}
          onUploadingChange={setUploading}
        />
      </div>
      {(draftError || error) && (
        <p className="error" role="alert">
          {draftError || error}
        </p>
      )}
      <div className="comment-form-actions">
        <button
          className="primary"
          disabled={busy || uploading || disabled || draftError || !body.trim()}
        >
          Send
        </button>
        {onCancel && (
          <button type="button" className="subtle-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
        )}
        {disabled && body.trim() && (
          <button
            type="button"
            className="subtle-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(body);
                if (mounted.current) setCopied(true);
              } catch {
                if (mounted.current) setError("Couldn't copy. Select the text and copy it.");
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        {onDiscard && body.trim() && (
          <button type="button" className="subtle-button" onClick={onDiscard} disabled={busy}>
            Discard
          </button>
        )}
      </div>
    </form>
  );
}
