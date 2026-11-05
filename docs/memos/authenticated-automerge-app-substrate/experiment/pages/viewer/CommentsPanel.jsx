import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  ListChecks,
  MessageSquare,
  RotateCcw,
  X,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { resolveCommentDraft } from "./comment-draft.mjs";
import { reloadGate } from "./build-freshness.mjs";
import { hasDraftText } from "./comment-composer.mjs";
import { Store, useStore } from "./store.mjs";
import { COMMENTS_SHEET_QUERY } from "./comments-layout.mjs";
import { CommentRichText } from "./CommentRichText.jsx";
import { AnchorChip, Message, MessageRuns, useNow } from "./CommentThreadParts.jsx";
import { threadLocation, threadTitle } from "./comment-thread-display.mjs";
import {
  LIST,
  afterResolve,
  groupByHeading,
  navigate,
  position,
  reviewKey,
} from "./comment-nav.mjs";
import "./comments.css";

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
    body = useRef(null),
    resolvedDisclosure = useRef(null);
  const [nav, dispatch] = useReducer(navigate, LIST);
  const returnTo = useRef(null);
  // The inline composer (CommentPopover) owns new comments. The panel shows a
  // draft only after the popover closed with text in it.
  const draft = useStore(composer?.store ?? NO_COMPOSER);
  const keptDraft = draft.state.name === "dismissed" ? draft : null;
  const [mobile, setMobile] = useState(() => matchMedia(COMMENTS_SHEET_QUERY).matches);
  const [drafts, setDrafts] = useState({});
  const now = useNow();
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
  // A passage clicked in the Page opens its thread. Selections made inside
  // the panel (focus, click) only highlight the passage.
  useEffect(() => {
    if (target?.source === "passage" && target.id) dispatch({ type: "show", id: target.id });
  }, [target]);
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
    const reviewing = nav.name === "review";
    const advanceTo =
      reviewing && thread.state === "open"
        ? afterResolve(
            thread.id,
            unresolved.map((item) => item.id),
          )
        : null;
    try {
      await session.comment({
        action: thread.state === "open" ? "resolve" : "reopen",
        thread_id: thread.id,
      });
      if (reviewing) {
        // Resolve-and-next: review moves on; the resolved thread stays in
        // the navigator to reopen.
        if (advanceTo) dispatch({ type: "go", id: advanceTo });
        requestAnimationFrame(() => body.current?.focus({ preventScroll: true }));
        return;
      }
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
        now={now}
        selected={target?.id === thread.id}
        changing={changing === thread.id}
        value={drafts[thread.id] || ""}
        onChange={(body) => changeDraft(thread.id, body)}
        onReveal={() => reveal(thread)}
        onSelect={() => {
          if (target?.id !== thread.id) onSelect?.(thread.id);
        }}
        onChangeThread={() => changeThread(thread)}
        current={drilled?.id === thread.id}
        onOpen={() => openThread(thread.id)}
      />
    );
  }
  const locate = (thread) => threadLocation(session.doc, thread);
  const unresolvedGroups = groupByHeading(
    threads.filter((thread) => thread.state === "open"),
    locate,
  );
  const unresolved = unresolvedGroups.flatMap((group) => group.threads);
  const resolved = groupByHeading(
    threads.filter((thread) => thread.state === "resolved"),
    locate,
  ).flatMap((group) => group.threads);
  const ordered = [...unresolved, ...resolved];
  const orderedIds = ordered.map((thread) => thread.id);
  const idsKey = orderedIds.join("\n");
  useEffect(() => dispatch({ type: "sync", ids: idsKey ? idsKey.split("\n") : [] }), [idsKey]);
  const drilled = nav.name !== "list" ? ordered.find((t) => t.id === nav.id) : null;
  const reviewing = Boolean(drilled) && nav.name === "review";
  const resolvedCount = resolved.length;
  function startReview() {
    const id = drilled?.id ?? unresolved[0]?.id ?? ordered[0]?.id;
    if (!id) return;
    dispatch({ type: "review", id, scroll: body.current?.scrollTop ?? 0 });
    requestAnimationFrame(() => body.current?.focus({ preventScroll: true }));
  }
  function reviewCommand(command) {
    switch (command) {
      case "next":
        return dispatch({ type: "step", by: 1, ids: orderedIds });
      case "previous":
        return dispatch({ type: "step", by: -1, ids: orderedIds });
      case "resolve":
        if (drilled?.state === "open" && session.canComment && changing !== drilled.id)
          changeThread(drilled);
        return;
      case "reply":
        dialog.current
          ?.querySelector(".thread-current .thread-reply-button:not([hidden])")
          ?.click();
        return;
      case "exit":
        dispatch({ type: "exit" });
        requestAnimationFrame(() => body.current?.focus({ preventScroll: true }));
        return;
    }
  }
  const where = drilled ? position(nav, orderedIds) : null;
  useEffect(() => {
    // A resolved thread lives inside the disclosure; open it to show the thread.
    if (drilled?.state === "resolved" && resolvedDisclosure.current)
      resolvedDisclosure.current.open = true;
  }, [drilled?.id, drilled?.state]);
  useLayoutEffect(() => {
    const scroller = body.current;
    if (!scroller) return;
    if (nav.name !== "list") {
      scroller.scrollTop = 0;
      return;
    }
    scroller.scrollTop = nav.scroll;
    const id = returnTo.current;
    returnTo.current = null;
    if (id)
      dialog.current
        ?.querySelector(`[data-thread-id="${CSS.escape(id)}"] .thread-open`)
        ?.focus({ preventScroll: true });
  }, [nav]);
  function openThread(id) {
    dispatch({ type: "open", id, scroll: body.current?.scrollTop ?? 0 });
  }
  function back() {
    returnTo.current = nav.name === "thread" ? nav.id : null;
    dispatch({ type: "back" });
  }
  function groupHeading(group) {
    return (
      <p key={`group:${group.key}`} className="comments-group">
        {group.heading === null ? "Detached" : group.heading || "Top of page"}
      </p>
    );
  }
  return (
    <dialog
      ref={dialog}
      inert={inert}
      id="page-comments"
      className={
        "comments" +
        (mobile ? " comments-sheet" : expanded ? " comments-expanded" : "") +
        (drilled ? " comments-drilled" : "") +
        (reviewing ? " comments-review" : "")
      }
      aria-labelledby="comments-title"
      onClose={() => {
        if (!dialog.current.open && open) onClose();
      }}
      onClick={(event) => {
        if (modal && event.target === dialog.current) onClose();
      }}
      onKeyDown={(event) => {
        if (reviewing) {
          const command = reviewKey(event);
          if (command) {
            event.preventDefault();
            reviewCommand(command);
            return;
          }
          if (event.key === "Escape") return;
        }
        if (!event.defaultPrevented && drilled && event.key === "Escape") {
          event.preventDefault();
          back();
          return;
        }
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
        {!reviewing && unresolved.length > 0 && (
          <button
            type="button"
            className="subtle-button comments-review-start"
            title="Review open threads one at a time (J/K to move, R to resolve, E to reply)"
            onClick={startReview}
          >
            <ListChecks size={16} aria-hidden="true" /> Review
          </button>
        )}
        {!mobile && !reviewing && (
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
      {drilled && (
        <nav className="comments-thread-nav" aria-label="Thread navigation">
          {reviewing ? (
            <button
              type="button"
              className="subtle-button comments-back"
              onClick={() => reviewCommand("exit")}
            >
              <ArrowLeft size={16} aria-hidden="true" /> Exit review
            </button>
          ) : (
            <button type="button" className="subtle-button comments-back" onClick={back}>
              <ArrowLeft size={16} aria-hidden="true" /> All comments
            </button>
          )}
          {where && (
            <span className="muted comments-position">
              {where.index} of {where.total}
            </span>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Previous thread"
            disabled={!where || where.index === 1}
            onClick={() => dispatch({ type: "step", by: -1, ids: orderedIds })}
          >
            <ChevronUp size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next thread"
            disabled={!where || where.index === where.total}
            onClick={() => dispatch({ type: "step", by: 1, ids: orderedIds })}
          >
            <ChevronDown size={17} aria-hidden="true" />
          </button>
        </nav>
      )}
      {reviewing && (
        <nav className="review-navigator" aria-label="Threads to review">
          <p className="review-progress">
            <span>
              {resolvedCount} of {ordered.length} resolved
            </span>
            <progress max={ordered.length || 1} value={resolvedCount} />
          </p>
          <ol>
            {ordered.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className={"review-item" + (thread.state === "resolved" ? " resolved" : "")}
                  aria-current={thread.id === drilled.id ? "true" : undefined}
                  onClick={() => dispatch({ type: "go", id: thread.id })}
                >
                  {thread.state === "resolved" && <Check size={13} aria-label="Resolved" />}
                  {threadTitle(thread.messages.find((m) => !m.deletedAt)?.body).title || "Comment"}
                </button>
              </li>
            ))}
          </ol>
          <p className="muted review-keys">
            <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>R</kbd> resolve · <kbd>E</kbd> reply ·{" "}
            <kbd>Esc</kbd> exit
          </p>
        </nav>
      )}
      <div className="comments-body" ref={body} tabIndex={-1}>
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
        {(open || visited) &&
          unresolvedGroups.flatMap((group) => [
            unresolvedGroups.length > 1 || group.heading ? groupHeading(group) : null,
            ...group.threads.map(renderThread),
          ])}
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
  now,
  selected,
  changing,
  value,
  onChange,
  onReveal,
  onSelect,
  onChangeThread,
  current = false,
  onOpen,
}) {
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  // Drilling into a thread shows the whole conversation.
  useEffect(() => {
    if (current) setRepliesExpanded(true);
  }, [current]);
  const [replying, setReplying] = useState(false);
  const [replyStarted, setReplyStarted] = useState(false);
  const [pending, setPending] = useState(false);
  const replyButton = useRef(null),
    form = useRef(null),
    pointerFocus = useRef(false);
  const repliesId = useId();
  const messages = thread.messages.filter((message) => !message.deletedAt);
  const [first, ...replies] = messages;
  const location = threadLocation(session.doc, thread);
  const { title } = threadTitle(first?.body);
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
        (selected ? " thread-active" : "") +
        (current ? " thread-current" : "")
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
      <AnchorChip anchor={location.anchor} onReveal={onReveal} />
      <div className="thread-heading">
        <h3 className="thread-title">
          {onOpen && !current ? (
            <button type="button" className="thread-open" onClick={onOpen}>
              {title || "Comment"}
            </button>
          ) : (
            title || "Comment"
          )}
        </h3>
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
        <Message message={first} source={session.commentMessage(thread.id, first.id)} now={now} />
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
        {repliesExpanded && (
          <MessageRuns
            messages={replies}
            sourceOf={(message) => session.commentMessage(thread.id, message.id)}
            now={now}
          />
        )}
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
  async function send() {
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
  }
  return (
    <form
      className={compact ? "comment-reply-form" : undefined}
      onKeyDownCapture={(event) => {
        // Mod+Enter sends, as in the inline composer (CommentPopover). The
        // rich editor isn't a form control, so no key submits this form on
        // its own; capture keeps the editor from taking the key first.
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        send();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        send();
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
