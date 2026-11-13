import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  ListChecks,
  MessageSquare,
  RotateCcw,
  X,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { resolveCommentDraft } from "./comment-draft.mjs";
import { reloadGate } from "./build-freshness.mjs";
import { draftComment, draftRecord, draftText, hasDraftText } from "./comment-composer.mjs";
import { Store, useStore } from "./store.mjs";
import { COMMENTS_SHEET_QUERY } from "./comments-layout.mjs";
import { CommentRichText } from "./CommentRichText.jsx";
import { AnchorChip, Avatar, Message, MessageRuns, useNow } from "./CommentThreadParts.jsx";
import {
  attribution,
  passageExcerpt,
  plainText,
  relativeTime,
  replyAuthors,
  threadLocation,
  threadPreview,
  threadTitle,
} from "./comment-thread-display.mjs";
import {
  LIST,
  afterResolve,
  groupByHeading,
  navigate,
  position,
  reviewKey,
} from "./comment-nav.mjs";
import { PageExcerpt, PassageSnippet } from "./PageExcerpt.jsx";
import "./comments.css";

const NO_COMPOSER = new Store({ state: { name: "idle" }, composer: null, body: "" });
const FILTERS = ["open", "mine", "resolved"];

/**
 * The comments panel: a list of threads grouped by the Page's headings, and
 * one thread drilled into from it (concept A). `navigate` in comment-nav.mjs
 * owns which view shows; this component renders it and runs the effects
 * (scroll, focus) after each transition. Reply drafts live here, keyed by
 * thread, so leaving a thread never loses one.
 */
export function CommentsPanel({
  open,
  session,
  threads,
  composer,
  target,
  principal = null,
  hovered = null,
  onClose,
  onReveal,
  onSelect,
}) {
  const dialog = useRef(null),
    list = useRef(null);
  const [nav, dispatch] = useReducer(navigate, LIST);
  const [filter, setFilter] = useState("open");
  const returnTo = useRef(null);
  // The inline composer (CommentPopover) owns new comments. The panel shows a
  // draft only after the popover closed with text in it.
  const draft = useStore(composer?.store ?? NO_COMPOSER);
  const keptDraft = draft.state.name === "dismissed" ? draft : null;
  const [mobile, setMobile] = useState(() => matchMedia(COMMENTS_SHEET_QUERY).matches);
  const [drafts, setDrafts] = useState({});
  const [sending, setSending] = useState({});
  const [replyRequest, setReplyRequest] = useState(null);
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
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
  // the panel (hover, focus) only light the passage.
  useEffect(() => {
    if (target?.source !== "passage" || !target.id) return;
    const thread = threads.find((item) => item.id === target.id);
    if (thread) setFilter((current) => filterFor(thread, current, principal));
    dispatch({ type: "show", id: target.id });
    // Only a new request should open a thread, not a thread list update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const changeDraft = (id, value) => setDrafts((previous) => ({ ...previous, [id]: value }));
  const markSending = (id, value) =>
    setSending((previous) => {
      const next = { ...previous };
      if (value) next[id] = true;
      else delete next[id];
      return next;
    });
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
              ...draftRecord(value),
              quote:
                thread.selectionContext?.status === "attached" ? thread.selectionContext.text : "",
            };
          }),
      ),
    [session],
  );
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

  // Threads in document order, grouped under their headings.
  const locate = (thread) => threadLocation(session.doc, thread);
  const openThreads = threads.filter((thread) => thread.state === "open");
  const resolvedThreads = threads.filter((thread) => thread.state === "resolved");
  const mine = threads.filter((thread) => involves(thread, principal));
  const visible = filter === "resolved" ? resolvedThreads : filter === "mine" ? mine : openThreads;
  const groups = groupByHeading(visible, locate);
  const ordered = groups.flatMap((group) => group.threads);
  const orderedIds = ordered.map((thread) => thread.id);
  const unresolvedIds = groupByHeading(openThreads, locate).flatMap((g) =>
    g.threads.map((t) => t.id),
  );
  const allIds = threads.map((thread) => thread.id);
  const idsKey = allIds.join("\n");
  useEffect(() => dispatch({ type: "sync", ids: idsKey ? idsKey.split("\n") : [] }), [idsKey]);
  const current = nav.name !== "list" ? threads.find((t) => t.id === nav.id) : null;
  // A thread opened from the Page may sit outside the filter; step within the
  // filter when it's there, else among every thread in document order.
  const stepIds =
    current && !orderedIds.includes(current.id)
      ? groupByHeading(threads, locate).flatMap((g) => g.threads.map((t) => t.id))
      : orderedIds;
  const where = current ? position(nav, stepIds) : null;
  const reviewing = Boolean(current) && nav.name === "review";
  const resolvedDraft = resolvedThreads.some((t) => hasDraft(drafts[t.id]));

  async function changeThread(thread) {
    setProblem("");
    setChanging(thread.id);
    const advanceTo =
      reviewing && thread.state === "open" ? afterResolve(thread.id, unresolvedIds) : null;
    try {
      await session.comment({
        action: thread.state === "open" ? "resolve" : "reopen",
        thread_id: thread.id,
      });
      if (reviewing && advanceTo) dispatch({ type: "go", id: advanceTo });
      requestAnimationFrame(() => {
        if (!dialog.current?.open) return;
        const active = document.activeElement;
        if (active && active !== document.body && dialog.current.contains(active)) {
          if (active.isConnected && !active.disabled) return;
        }
        dialog.current
          .querySelector(".thread-view .thread-state-action, .comments-back")
          ?.focus({ preventScroll: true });
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
  function openThread(id, { reply = false } = {}) {
    dispatch({ type: "open", id, scroll: list.current?.scrollTop ?? 0 });
    if (reply) setReplyRequest({ id, at: performance.now() });
    if (target?.id !== id) onSelect?.(id);
  }
  function back() {
    returnTo.current = nav.name !== "list" ? nav.id : null;
    // Return to a list that shows the thread just left.
    if (current) setFilter((value) => filterFor(current, value, principal));
    dispatch({ type: "back" });
  }
  function step(by) {
    dispatch({ type: "step", by, ids: stepIds });
  }
  useEffect(() => {
    if (current && target?.id !== current.id) onSelect?.(current.id);
    // Light the passage of whichever thread is showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  // A comment kept from the inline composer lists at the top of the list;
  // return there so it isn't hidden behind an open thread.
  const keptKey = keptDraft ? keptDraft.composer : null;
  useEffect(() => {
    if (keptKey) dispatch({ type: "back" });
  }, [keptKey]);
  function startReview() {
    const id = current?.id ?? unresolvedIds[0] ?? orderedIds[0];
    if (!id) return;
    dispatch({ type: "review", id, scroll: list.current?.scrollTop ?? 0 });
    requestAnimationFrame(() =>
      dialog.current?.querySelector(".thread-view")?.focus({ preventScroll: true }),
    );
  }
  // Each thread's view is keyed by its ID, so stepping in review replaces the
  // view that held focus and focus falls to the body, out of reach of the
  // dialog's review keys. Hand it to the new thread's view.
  useLayoutEffect(() => {
    if (!reviewing) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    dialog.current?.querySelector(".thread-view")?.focus({ preventScroll: true });
  }, [reviewing, current?.id]);
  function reviewCommand(command) {
    switch (command) {
      case "next":
        return dispatch({ type: "step", by: 1, ids: allInOrder() });
      case "previous":
        return dispatch({ type: "step", by: -1, ids: allInOrder() });
      case "resolve":
        if (current?.state === "open" && session.canComment && changing !== current.id)
          changeThread(current);
        return;
      case "reply":
        if (current) setReplyRequest({ id: current.id, at: performance.now() });
        return;
      case "exit":
        dispatch({ type: "exit" });
        return;
    }
  }
  const allInOrder = () => [
    ...unresolvedIds,
    ...groupByHeading(resolvedThreads, locate).flatMap((g) => g.threads.map((t) => t.id)),
  ];
  // Restore the list where it was and return focus to the thread just left.
  useLayoutEffect(() => {
    if (nav.name !== "list") return;
    if (list.current) list.current.scrollTop = nav.scroll;
    const id = returnTo.current;
    returnTo.current = null;
    if (id)
      dialog.current
        ?.querySelector(`.thread-row[data-thread-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true });
  }, [nav]);

  function rowKeys(event) {
    const rows = [...(list.current?.querySelectorAll(".thread-row") ?? [])];
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move) {
      event.preventDefault();
      rows[Math.min(rows.length - 1, Math.max(0, index + move))]?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? rows[0] : rows.at(-1))?.focus();
      return;
    }
    if (event.key.toLowerCase() === "r" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const id = rows[index].dataset.threadId;
      const thread = threads.find((item) => item.id === id);
      if (thread?.state === "open" && session.canComment) {
        event.preventDefault();
        openThread(id, { reply: true });
      }
    }
  }

  const threadView = (thread) => (
    <ThreadView
      key={thread.id}
      thread={thread}
      session={session}
      now={now}
      excerpt={passageExcerpt(session.doc, thread)}
      location={locate(thread)}
      clamp={!reviewing}
      changing={changing === thread.id}
      sending={Boolean(sending[thread.id])}
      value={drafts[thread.id] || ""}
      replyRequest={replyRequest?.id === thread.id ? replyRequest.at : null}
      onChange={(body) => changeDraft(thread.id, body)}
      onSending={(value) => markSending(thread.id, value)}
      onReveal={() => reveal(thread)}
      onChangeThread={() => changeThread(thread)}
    />
  );
  const split = expanded && !mobile && !reviewing;
  const showList = !current || split;
  const counts = { open: openThreads.length, mine: mine.length, resolved: resolvedThreads.length };
  return (
    <dialog
      ref={dialog}
      inert={inert}
      id="page-comments"
      className={
        "comments" +
        (mobile ? " comments-sheet" : expanded ? " comments-expanded" : "") +
        (current ? " comments-drilled" : "") +
        (split ? " comments-split" : "") +
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
        if (
          current &&
          !event.defaultPrevented &&
          reviewKey(event) === "reply" &&
          current.state === "open" &&
          session.canComment
        ) {
          // In a thread, R starts a reply (in review it resolves).
          event.preventDefault();
          setReplyRequest({ id: current.id, at: performance.now() });
          return;
        }
        if (event.defaultPrevented || event.key !== "Escape") return;
        if (current && !split) {
          event.preventDefault();
          back();
        } else if (!modal) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {reviewing ? (
        <ReviewWorkspace
          current={current}
          threads={threads}
          order={allInOrder()}
          locate={locate}
          now={now}
          drafts={drafts}
          problem={problem}
          canComment={session.canComment}
          changing={changing === current.id || Boolean(sending[current.id])}
          onGo={(id) => dispatch({ type: "go", id })}
          onStep={(by) => reviewCommand(by > 0 ? "next" : "previous")}
          onResolveNext={() => reviewCommand("resolve")}
          onExit={() => reviewCommand("exit")}
          onOpenInPage={() => {
            onClose();
            requestAnimationFrame(() => onReveal(current));
          }}
          onClose={onClose}
          threadView={threadView(current)}
        />
      ) : (
        <>
          {showList && (
            <section className="comments-list-pane" aria-label="Comment threads">
              <div className="comments-heading">
                <h2 id="comments-title">
                  <MessageSquare size={17} aria-hidden="true" /> Comments
                </h2>
                {!mobile && (
                  <button
                    type="button"
                    className="icon-button comments-expand"
                    aria-label={expanded ? "Narrow comments" : "Expand comments"}
                    title={expanded ? "Narrow comments" : "Expand comments"}
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded ? (
                      <Minimize2 size={16} aria-hidden="true" />
                    ) : (
                      <Maximize2 size={16} aria-hidden="true" />
                    )}
                  </button>
                )}
                <button className="icon-button" aria-label="Close comments" onClick={onClose}>
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
              <div className="comments-filters">
                <div className="comments-segmented" role="tablist" aria-label="Show threads">
                  {FILTERS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      aria-selected={filter === name}
                      className="comments-filter"
                      onClick={() => setFilter(name)}
                    >
                      {name === "open" ? "Open" : name === "mine" ? "Mine" : "Resolved"}
                      {name !== "mine" && (
                        <span className="comments-filter-count">{counts[name]}</span>
                      )}
                      {name === "resolved" && resolvedDraft && (
                        <span className="comments-filter-draft" title="Unsent reply">
                          ·
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {openThreads.length > 0 && (
                  <button
                    type="button"
                    className="icon-button comments-review-start"
                    aria-label="Review open threads"
                    title="Review open threads one at a time"
                    onClick={startReview}
                  >
                    <ListChecks size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="comments-body comments-list" ref={list} onKeyDown={rowKeys}>
                {problem && !current && (
                  <p role="alert" className="error">
                    {problem}
                  </p>
                )}
                {session.commentsUnavailable && (
                  <p role="alert" className="error comments-unavailable">
                    Comments couldn't load. You can still read the Page.{" "}
                    <button
                      type="button"
                      className="subtle-button"
                      onClick={() => session.retryComments()}
                    >
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
                        {draftProblem}. Copy the text, then select a passage and choose Comment
                        again.
                      </p>
                    )}
                    <p className="comment-kept-draft-text">{draftText(keptDraft.body)}</p>
                    <div className="comment-form-actions">
                      {session.canComment && !draftProblem && (
                        <button type="button" className="primary" onClick={continueDraft}>
                          Continue
                        </button>
                      )}
                      <button
                        type="button"
                        className="subtle-button"
                        onClick={() => composer.cancel()}
                      >
                        Discard
                      </button>
                    </div>
                  </section>
                )}
                {!visible.length && (
                  <p className="muted comments-empty">
                    {emptyText(filter, threads.length, session.canComment)}
                  </p>
                )}
                {groups.map((group) => (
                  <div className="comments-group-block" key={`group:${group.key}`}>
                    {group.heading !== "" && (
                      <p className="comments-group">
                        <span>{group.heading === null ? "Detached" : group.heading}</span>
                      </p>
                    )}
                    {group.threads.map((thread) => (
                      <ThreadRow
                        key={thread.id}
                        thread={thread}
                        now={now}
                        location={locate(thread)}
                        active={(current?.id ?? target?.id) === thread.id}
                        hovered={hovered === thread.id}
                        draft={hasDraft(drafts[thread.id])}
                        onOpen={() => openThread(thread.id)}
                        onHover={() => {
                          if (target?.id !== thread.id) onSelect?.(thread.id);
                        }}
                      />
                    ))}
                  </div>
                ))}
                {filter === "open" && resolvedThreads.length > 0 && (
                  <button
                    type="button"
                    className="comments-list-end"
                    onClick={() => setFilter("resolved")}
                  >
                    <CircleCheck size={14} aria-hidden="true" />
                    <span>
                      {resolvedThreads.length} resolved{" "}
                      {resolvedThreads.length === 1 ? "thread" : "threads"}
                      {resolvedDraft ? " · unsent reply" : ""}
                    </span>
                    <span className="comments-list-end-action">Show</span>
                  </button>
                )}
              </div>
              {!mobile && (
                <p className="comments-keys" aria-hidden="true">
                  <span>
                    <kbd>↑</kbd>
                    <kbd>↓</kbd> Move
                  </span>
                  <span>
                    <kbd>↵</kbd> Open
                  </span>
                  {session.canComment && (
                    <span>
                      <kbd>R</kbd> Reply
                    </span>
                  )}
                  <span className="comments-keys-end">
                    <kbd>esc</kbd> Close
                  </span>
                </p>
              )}
            </section>
          )}
          {current && !reviewing ? (
            <section className="comments-thread-pane" aria-label="Thread">
              <div className="comments-heading comments-thread-nav">
                {reviewing ? (
                  <button
                    type="button"
                    className="subtle-button comments-back"
                    onClick={() => reviewCommand("exit")}
                  >
                    <ChevronLeft size={17} aria-hidden="true" /> Exit review
                  </button>
                ) : split ? (
                  <span className="comments-split-title">Thread</span>
                ) : (
                  <button type="button" className="subtle-button comments-back" onClick={back}>
                    <ChevronLeft size={17} aria-hidden="true" /> All comments
                  </button>
                )}
                {where && (
                  <span className="comments-position">
                    <b>{where.index}</b> of {where.total}
                  </span>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Previous thread"
                  disabled={!where || where.index === 1}
                  onClick={() => step(-1)}
                >
                  <ChevronUp size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Next thread"
                  disabled={!where || where.index === where.total}
                  onClick={() => step(1)}
                >
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
                {!split && !mobile && !reviewing && (
                  <button
                    type="button"
                    className="icon-button comments-expand"
                    aria-label="Expand comments"
                    title="Expand comments"
                    onClick={() => setExpanded(true)}
                  >
                    <Maximize2 size={16} aria-hidden="true" />
                  </button>
                )}
                {!split && (
                  <button className="icon-button" aria-label="Close comments" onClick={onClose}>
                    <X size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
              {problem && (
                <p role="alert" className="error comments-thread-problem">
                  {problem}
                </p>
              )}
              {threadView(current)}
            </section>
          ) : (
            split && (
              <section className="comments-thread-pane comments-thread-empty" aria-label="Thread">
                <p className="muted">Choose a thread to read it here.</p>
              </section>
            )
          )}
        </>
      )}
    </dialog>
  );
}

const hasDraft = hasDraftText;

/** Whether `principal` started or replied in a thread. */
function involves(thread, principal) {
  return (
    Boolean(principal) &&
    thread.messages.some((message) => !message.deletedAt && message.author?.principal === principal)
  );
}

/** The filter that shows `thread`, keeping the current one when it does. */
function filterFor(thread, current, principal) {
  if (current === "mine" && involves(thread, principal)) return current;
  if (current === "resolved" && thread.state === "resolved") return current;
  if (current === "open" && thread.state === "open") return current;
  return thread.state === "resolved" ? "resolved" : "open";
}

function emptyText(filter, total, canComment) {
  if (filter === "resolved") return "No resolved threads.";
  if (filter === "mine") return "No threads you've started or replied to.";
  if (total) return "All caught up.";
  return canComment ? "No comments yet. Select text to add one." : "No comments yet.";
}

/**
 * Review (concept C): a full-width workspace. Threads to review on the left,
 * the passage live in its Page in the middle, and the conversation with
 * Resolve and next on the right. Keys: J/K move, R reply, E resolve and
 * next, Esc back to the panel.
 */
function ReviewWorkspace({
  current,
  threads,
  order,
  locate,
  now,
  drafts,
  problem,
  canComment,
  changing,
  onGo,
  onStep,
  onResolveNext,
  onExit,
  onOpenInPage,
  onClose,
  threadView,
}) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  const open = ordered.filter((thread) => thread.state === "open");
  const resolved = ordered.filter((thread) => thread.state === "resolved");
  const done = resolved.length;
  const index = ordered.findIndex((thread) => thread.id === current.id);
  const next =
    current.state === "open"
      ? afterResolve(
          current.id,
          open.map((t) => t.id),
        )
      : null;
  const upNext = next ? byId.get(next) : null;
  const location = locate(current);
  const path = location.headings;
  const groups = groupByHeading(open, locate);
  const [showResolved, setShowResolved] = useState(current.state === "resolved");
  useEffect(() => {
    if (current.state === "resolved") setShowResolved(true);
  }, [current.id, current.state]);
  const row = (thread) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      now={now}
      location={locate(thread)}
      active={thread.id === current.id}
      draft={hasDraft(drafts[thread.id])}
      onOpen={() => onGo(thread.id)}
      onHover={() => {}}
    />
  );
  return (
    <>
      <div className="comments-heading review-heading">
        <h2 id="comments-title">
          <ListChecks size={17} aria-hidden="true" /> Review comments
        </h2>
        <span className="review-progress-label">
          <b>{done}</b> of {ordered.length} resolved
        </span>
        <span className="review-progress-bar" aria-hidden="true">
          <span style={{ width: `${ordered.length ? (done / ordered.length) * 100 : 0}%` }} />
        </span>
        <button type="button" className="subtle-button comments-back" onClick={onExit}>
          Exit review
        </button>
        <button className="icon-button" aria-label="Close comments" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="review-grid">
        <nav className="review-navigator" aria-label="Threads to review">
          <div className="comments-body comments-list">
            {groups.map((group) => (
              <div className="comments-group-block" key={`group:${group.key}`}>
                {group.heading !== "" && (
                  <p className="comments-group">
                    <span>{group.heading === null ? "Detached" : group.heading}</span>
                  </p>
                )}
                {group.threads.map(row)}
              </div>
            ))}
            {!open.length && <p className="muted comments-empty">All caught up.</p>}
            {resolved.length > 0 && (
              <>
                <button
                  type="button"
                  className="comments-list-end"
                  aria-expanded={showResolved}
                  onClick={() => setShowResolved((value) => !value)}
                >
                  {showResolved ? (
                    <ChevronDown size={14} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={14} aria-hidden="true" />
                  )}
                  <span>Resolved</span>
                  <span className="comments-filter-count">{resolved.length}</span>
                </button>
                {showResolved && resolved.map(row)}
              </>
            )}
          </div>
        </nav>
        <section className="review-context" aria-label="Passage in the Page">
          <div className="review-column-head">
            <span className="review-crumbs">
              {path.map((heading, i) => (
                <span key={i}>
                  {i > 0 && <ChevronRight size={13} aria-hidden="true" />}
                  <span className={i === path.length - 1 ? "here" : undefined}>{heading}</span>
                </span>
              ))}
            </span>
            <button type="button" className="subtle-button review-open-page" onClick={onOpenInPage}>
              Open in Page
            </button>
          </div>
          <PageExcerpt thread={current} />
        </section>
        <section className="review-conversation" aria-label="Conversation">
          <div className="review-column-head">
            <span className="comments-position">
              <b>{index + 1}</b> of {ordered.length}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Previous thread"
              title="Previous thread (K)"
              disabled={index <= 0}
              onClick={() => onStep(-1)}
            >
              <ChevronUp size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Next thread"
              title="Next thread (J)"
              disabled={index === ordered.length - 1}
              onClick={() => onStep(1)}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
          {problem && (
            <p role="alert" className="error comments-thread-problem">
              {problem}
            </p>
          )}
          {threadView}
          {canComment && current.state === "open" && (
            <div className="review-dock">
              <button
                type="button"
                className="review-resolve-next"
                disabled={changing}
                onClick={onResolveNext}
              >
                <Check size={15} aria-hidden="true" /> Resolve and next <kbd>E</kbd>
              </button>
              {upNext ? (
                <span className="review-up-next">
                  <span className="review-up-next-label">Up next</span>
                  <Avatar author={upNext.messages[0]?.author} size={16} />
                  <span className="review-up-next-title">
                    {threadTitle(upNext.messages.find((m) => !m.deletedAt)?.body).title ||
                      "Comment"}
                  </span>
                </span>
              ) : (
                <span className="review-up-next review-up-next-label">Last open thread</span>
              )}
            </div>
          )}
        </section>
      </div>
      <footer className="review-keys" aria-hidden="true">
        <span>
          <kbd>J</kbd>
          <kbd>K</kbd> Next / previous thread
        </span>
        {canComment && (
          <>
            <span>
              <kbd>R</kbd> Reply
            </span>
            <span>
              <kbd>E</kbd> Resolve and next
            </span>
            <span>
              <kbd>⌘</kbd>
              <kbd>↵</kbd> Send
            </span>
          </>
        )}
        <span>
          <kbd>Esc</kbd> Back
        </span>
      </footer>
    </>
  );
}

/** One compact row in the thread list. Clicking opens the thread. */
function ThreadRow({ thread, now, location, active, hovered = false, draft, onOpen, onHover }) {
  const messages = thread.messages.filter((message) => !message.deletedAt);
  const [first] = messages;
  const last = messages.at(-1);
  const { title } = threadTitle(first?.body);
  const preview = threadPreview(first?.body) || (title ? "" : plainText(first?.body));
  const replies = messages.length - 1;
  const repliers = replyAuthors(messages);
  const who = attribution(first?.author);
  const anchor = location.anchor;
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      className={
        "thread-row" +
        (active ? " thread-row-active" : "") +
        (hovered ? " thread-row-hovered" : "") +
        (thread.state === "resolved" ? " resolved" : "") +
        (title.length > 42 ? " thread-row-two" : "")
      }
      style={{ "--rail": who.color }}
      data-thread-id={thread.id}
      onClick={onOpen}
      onPointerEnter={onHover}
      onFocus={onHover}
    >
      <Avatar author={first?.author} size={26} />
      <span className="thread-row-main">
        <span className="thread-row-line">
          <span className="thread-row-title">{title || "Comment"}</span>
          {draft && <span className="thread-row-draft">Draft</span>}
          {last?.createdAt && (
            <time className="thread-row-time" dateTime={last.createdAt}>
              {relativeTime(last.createdAt, now)}
            </time>
          )}
        </span>
        {preview && <span className="thread-row-preview">{preview}</span>}
        <span className="thread-row-meta">
          <span className={"thread-row-chip thread-row-chip-" + anchor.kind}>
            {anchor.kind === "block" && <ListChecks size={12} aria-hidden="true" />}
            <span>
              {anchor.kind === "selection"
                ? anchor.text
                : anchor.kind === "block"
                  ? anchor.label
                  : "Passage removed"}
            </span>
          </span>
          {replies > 0 && (
            <span className="thread-row-replies">
              <span className="thread-row-avatars" aria-hidden="true">
                {repliers.map((author, index) => (
                  <Avatar key={index} author={author} size={16} />
                ))}
              </span>
              <span className="thread-row-count">
                {replies}
                <span className="sr-only"> {replies === 1 ? "reply" : "replies"}</span>
              </span>
            </span>
          )}
        </span>
      </span>
      <ChevronRight size={14} className="thread-row-chevron" aria-hidden="true" />
    </button>
  );
}

/**
 * One thread, opened: its title, state and Resolve; the passage in its
 * paragraph; the conversation; and a reply composer docked at the bottom.
 * `clamp` puts long message bodies behind Show more. Review shows them whole,
 * since each thread there is read through before it is resolved.
 */
function ThreadView({
  thread,
  session,
  now,
  excerpt,
  location,
  clamp,
  changing,
  sending,
  value,
  replyRequest,
  onChange,
  onSending,
  onReveal,
  onChangeThread,
}) {
  const messages = thread.messages.filter((message) => !message.deletedAt);
  const [first, ...replies] = messages;
  const { title } = threadTitle(first?.body);
  const canReply = session.canComment && thread.state === "open";
  // A typed reply that can't be sent (edits paused, access lost, or the
  // thread resolved) stays visible, read-only, so it can be copied or
  // discarded. Reload counts it until then.
  const keptDraft = !canReply && hasDraft(value);
  const [replying, setReplying] = useState(() => hasDraft(value));
  const form = useRef(null),
    replyButton = useRef(null);
  useEffect(() => {
    if (replyRequest && canReply) setReplying(true);
  }, [replyRequest, canReply]);
  useEffect(() => {
    if (!replying || !replyRequest) return;
    const frame = requestAnimationFrame(() =>
      form.current?.querySelector('[role="textbox"]')?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [replying, replyRequest]);
  return (
    <div className="thread-view" data-thread-id={thread.id} tabIndex={-1}>
      <div className="thread-view-scroll">
        <header className="thread-view-head">
          <div className="thread-view-titles">
            <h3 className="thread-title">{title || "Comment"}</h3>
            {/* Resolve / Reopen already says which state it's in; without
                that button (viewers) a resolved thread still says so. */}
            {!session.canComment && thread.state === "resolved" && (
              <p className="thread-view-meta">
                <span className="thread-state thread-state-resolved">Resolved</span>
              </p>
            )}
          </div>
          {session.canComment && (
            <button
              type="button"
              className={"thread-state-action thread-state-action-" + thread.state}
              disabled={changing || sending}
              onClick={onChangeThread}
            >
              {thread.state === "open" ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <RotateCcw size={14} aria-hidden="true" />
              )}
              {thread.state === "open" ? "Resolve" : "Reopen"}
            </button>
          )}
        </header>
        <div className={"thread-passage thread-passage-" + location.anchor.kind}>
          {excerpt ? (
            <PassageSnippet thread={thread}>
              <p className="thread-passage-text">
                {excerpt.before}
                <mark>{excerpt.passage}</mark>
                {excerpt.after}
              </p>
            </PassageSnippet>
          ) : (
            <p className="thread-passage-text thread-passage-removed">
              The passage this thread pointed at was removed.
            </p>
          )}
          {(location.anchor.kind !== "detached" || location.anchor.blockSurvives) && (
            <button type="button" className="thread-passage-jump quote" onClick={onReveal}>
              Jump to passage
            </button>
          )}
        </div>
        <div className="thread-messages">
          {first && (
            <Message
              message={first}
              source={session.commentMessage(thread.id, first.id)}
              now={now}
              clamp={clamp}
            />
          )}
          {replies.length > 0 && (
            <>
              <p className="thread-divider">
                {replies.length} {replies.length === 1 ? "reply" : "replies"}
              </p>
              <div className="thread-replies">
                <MessageRuns
                  messages={replies}
                  sourceOf={(message) => session.commentMessage(thread.id, message.id)}
                  now={now}
                  clamp={clamp}
                />
              </div>
            </>
          )}
        </div>
      </div>
      {(canReply || keptDraft) && (
        <div className="thread-composer" ref={form}>
          {keptDraft && <p className="muted thread-kept-draft">Unsent reply</p>}
          {replying || keptDraft ? (
            <CommentForm
              label="Reply"
              compact
              value={value}
              onChange={onChange}
              disabled={!canReply}
              images={{ pageId: session.pageId, canUpload: session.canComment && session.canWrite }}
              onDiscard={() => {
                onChange("");
                if (!keptDraft) {
                  setReplying(false);
                  requestAnimationFrame(() => replyButton.current?.focus({ preventScroll: true }));
                }
              }}
              submit={(draft) => {
                const [content, spans] = draftComment(draft);
                return session.comment(
                  { action: "reply", thread_id: thread.id, ...content },
                  spans,
                );
              }}
              onBusyChange={onSending}
              onSuccess={() => {
                const restore = form.current?.contains(document.activeElement);
                setReplying(false);
                if (restore)
                  requestAnimationFrame(() => replyButton.current?.focus({ preventScroll: true }));
              }}
              onCancel={keptDraft ? undefined : () => setReplying(false)}
              cancelLabel="Hide reply"
            />
          ) : (
            <button
              ref={replyButton}
              type="button"
              className="thread-reply-button"
              aria-label={hasDraft(value) ? "Continue reply" : "Reply"}
              onClick={() => {
                setReplying(true);
                requestAnimationFrame(() =>
                  form.current?.querySelector('[role="textbox"]')?.focus({ preventScroll: true }),
                );
              }}
            >
              <span>
                {hasDraft(value)
                  ? "Continue reply"
                  : `Reply to ${attribution(messages.at(-1)?.author).name}…`}
              </span>
              <kbd aria-hidden="true">R</kbd>
            </button>
          )}
        </div>
      )}
    </div>
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
  const body = draftText(value);
  const ready = hasDraftText(value);
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
    if (busy || uploading || disabled || draftError || !ready) return;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      await submit(value);
      // The draft belongs to the panel, so a send that finishes after this
      // form unmounted (the thread was left mid-send) still clears it.
      onChange("");
      if (mounted.current) onSuccess?.();
    } catch (error) {
      if (mounted.current) setError(error.message);
    } finally {
      onBusyChange?.(false);
      if (mounted.current) setBusy(false);
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
          value={value}
          onChange={onChange}
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
          className="primary comment-send"
          disabled={busy || uploading || disabled || draftError || !ready}
          title="Send (⌘/Ctrl+Enter)"
        >
          Send <kbd aria-hidden="true">⌘↵</kbd>
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
        {onDiscard && ready && (
          <button type="button" className="subtle-button" onClick={onDiscard} disabled={busy}>
            Discard
          </button>
        )}
      </div>
    </form>
  );
}
