import "../../../../../../src/styles/notebook-tokens.css";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as A from "@automerge/automerge";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  LogOut,
  Link,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Plug,
  Search,
  Type,
  Trash2,
  UserRound,
} from "lucide-react";
import { PageSession, request, tool, listLocalPages, forgetLocalPage } from "./session.mjs";
import {
  pagePath,
  readPageRoute,
  writePageRoute,
  isPlainNavigation,
  mergePageListings,
} from "../shared/routes.mjs";
import { maintainBrowserSession } from "./browser-session.mjs";
import { openPageWithRetry } from "./page-open.mjs";
import { WordgardEditor } from "./WordgardEditor.jsx";
import { PagePicker } from "./PagePicker.jsx";
import { matchingPages } from "./page-list.mjs";
import { SharingControls } from "./SharingControls.jsx";
import { AppearanceControls } from "./AppearanceControls.jsx";
import { CommentsPanel } from "./CommentsPanel.jsx";
import { SaveStatus } from "./SaveStatus.jsx";
import { PageActivity } from "./PageActivity.jsx";
import { captureCommentDraft } from "./comment-draft.mjs";
import { writingContinuation } from "./writing-continuation.mjs";
import { retryKey } from "../model/retry-key.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import "./style.css";
import "./formatting-toolbar.css";
import { focusCreatedPageTitle, titleHandsOffToBody } from "./title-navigation.mjs";

function App() {
  const accountDisclosure = useDismissibleDisclosure(),
    documentDisclosure = useDismissibleDisclosure(),
    activityDisclosure = useDismissibleDisclosure();
  const [account, setAccount] = useState(undefined),
    [pages, setPages] = useState([]),
    [session, setSession] = useState(null),
    [, paint] = useState(0),
    [error, setError] = useState(""),
    [authError, setAuthError] = useState(""),
    [notice, setNotice] = useState(""),
    [libraryQuery, setLibraryQuery] = useState("");
  const [toolbar, setToolbar] = useState(null),
    [toolbarOpen, setToolbarOpen] = useState(false),
    [active, setActive] = useState(null),
    [commentsOpen, setCommentsOpen] = useState(false),
    [composer, setComposer] = useState(null),
    [target, setTarget] = useState(null),
    [pickerOpen, setPickerOpen] = useState(false),
    [pickerError, setPickerError] = useState(""),
    [creating, setCreating] = useState(false),
    [opening, setOpening] = useState(false),
    [focusBlock, setFocusBlock] = useState(null),
    [titleFocusRequest, setTitleFocusRequest] = useState(null),
    [localRecoveries, setLocalRecoveries] = useState([]);
  const current = useRef(null),
    auth = useRef(null),
    closingPages = useRef(new Map()),
    authentication = useRef(null),
    catalogRevision = useRef(0),
    creationPending = useRef(false),
    generation = useRef(0),
    openingRequest = useRef(null),
    composerId = useRef(null),
    article = useRef(null),
    titleInput = useRef(null),
    commentsButton = useRef(null),
    reloadingAccess = useRef(null);
  const refresh = async () => {
    const identity = authentication.current?.identity;
    if (!identity) return [];
    const revision = ++catalogRevision.current;
    const remoteRequest = tool("list_pages").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const local = await listLocalPages(identity).catch(() => []);
    const stillCurrent = () =>
      identity.principal === authentication.current?.identity?.principal &&
      revision === catalogRevision.current;
    if (!stillCurrent()) return [];
    setPages((previous) => mergePageListings(previous, local));
    const remote = await remoteRequest;
    if (!stillCurrent()) return [];
    const result = mergePageListings(remote.value?.pages ?? null, local);
    setPages(result);
    if (remote.error && !result.length) throw remote.error;
    return result;
  };
  function activateBlock(id) {
    setActive(id);
  }
  function showFormatting(open, focus = false) {
    setToolbarOpen(open);
    if (documentDisclosure.current) documentDisclosure.current.open = false;
    if (focus && open)
      requestAnimationFrame(() => {
        toolbar?.querySelector("select:not(:disabled),button:not(:disabled)")?.focus();
      });
  }
  function formattingShortcut(event) {
    if (
      session?.canWrite &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key === "F10"
    ) {
      event.preventDefault();
      event.stopPropagation();
      showFormatting(true, true);
    }
  }
  function nextGeneration() {
    openingRequest.current?.abort();
    openingRequest.current = null;
    return ++generation.current;
  }
  function resetDocumentUI() {
    setActive(null);
    setToolbarOpen(false);
    composerId.current = null;
    setComposer(null);
    setTarget(null);
    setCommentsOpen(false);
    setFocusBlock(null);
    setTitleFocusRequest(null);
    setLocalRecoveries([]);
  }
  function releaseCurrent() {
    const old = current.current;
    current.current = null;
    setSession(null);
    resetDocumentUI();
    if (old) {
      old.publishPresence(null);
      const key = old.identity.principal + ":" + old.pageId;
      const closing = old
        .close()
        .catch((error) => setError(error.message))
        .finally(() => {
          if (closingPages.current.get(key) === closing) closingPages.current.delete(key);
        });
      closingPages.current.set(key, closing);
    }
  }
  async function install(next, revision, { focus = false } = {}) {
    if (
      revision !== generation.current ||
      next.identity.principal !== authentication.current?.identity?.principal
    ) {
      await next.close();
      return false;
    }
    current.current = next;
    setSession(next);
    next.subscribe(() => {
      if (current.current === next) {
        paint((n) => n + 1);
        if (next.accessReloadRequired && !next.recoveryPending) void reloadAccess(next);
      }
    });
    void next
      .listRecoveries()
      .then((records) => {
        if (current.current === next) setLocalRecoveries(records);
      })
      .catch(() => {});
    if (next.accessReloadRequired && !next.recoveryPending) void reloadAccess(next);
    const first = orderedBlockIds(next.doc)[0] ?? null;
    activateBlock(first);
    if (focus) setFocusBlock(first);
    return true;
  }
  async function reloadAccess(previous = current.current) {
    if (!previous || current.current !== previous || reloadingAccess.current === previous) return;
    reloadingAccess.current = previous;
    const revision = nextGeneration();
    try {
      const next = await previous.reloadForAccess();
      await install(next, revision);
    } catch (error) {
      if (current.current === previous) setError(error.message);
    } finally {
      if (reloadingAccess.current === previous) reloadingAccess.current = null;
    }
  }
  function downloadDraft(record) {
    const draft = current.current?.exportRecovery(record);
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.page_id}-local-draft.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function open(id, { focus = false, historyMode = "push" } = {}) {
    if (historyMode !== "none") writePageRoute(id, { replace: historyMode === "replace" });
    setPickerOpen(false);
    setNotice("");
    if (current.current?.pageId === id) return;
    const revision = nextGeneration();
    const controller = new AbortController();
    openingRequest.current = controller;
    setError("");
    setOpening(true);
    releaseCurrent();
    try {
      // A quick Back may revisit a replica whose final local checkpoint is
      // still flushing. Wait only for that same Page, never an unrelated one.
      await closingPages.current.get(authentication.current?.identity?.principal + ":" + id);
      if (revision !== generation.current) return;
      const next = await openPageWithRetry(
        () =>
          PageSession.open(id, {
            authentication: authentication.current,
            refreshSession: () => auth.current.refresh(),
          }),
        { signal: controller.signal },
      );
      await install(next, revision, { focus });
    } catch (error) {
      if (revision === generation.current) setError(error.message);
    } finally {
      if (openingRequest.current === controller) openingRequest.current = null;
      if (revision === generation.current) setOpening(false);
    }
  }
  function home(event, { historyMode = "push", refreshCatalog = true } = {}) {
    if (event) {
      if (!isPlainNavigation(event)) return;
      event.preventDefault();
    }
    nextGeneration();
    releaseCurrent();
    setAccount(authentication.current?.identity ?? null);
    setError("");
    setNotice("");
    setOpening(false);
    setPickerOpen(false);
    if (historyMode !== "none") writePageRoute(null, { replace: historyMode === "replace" });
    if (refreshCatalog) void refresh().catch((error) => setError(error.message));
  }
  function followRoute() {
    const route = readPageRoute(location.href);
    if (route.kind === "page") void open(route.pageId, { historyMode: "replace" });
    else if (route.kind === "home") home(null, { historyMode: "none", refreshCatalog: false });
    else {
      nextGeneration();
      releaseCurrent();
      setOpening(false);
      setError("This Page link is not valid.");
    }
    void refresh().catch((error) => {
      if (!current.current) setError(error.message);
    });
  }
  useEffect(() => {
    let alive = true;
    const maintenance = maintainBrowserSession({
      request: () => request("/api/auth/session"),
      onSession: (result) => {
        if (!alive) return;
        setAuthError("");
        const changed = authentication.current?.identity?.principal !== result.identity?.principal;
        if (changed) {
          nextGeneration();
          catalogRevision.current++;
          setPages([]);
          setOpening(false);
        }
        authentication.current = result;
        const live = current.current;
        if (!live) {
          setAccount(result.identity);
          if (changed && result.identity) followRoute();
        } else {
          const resume = live.authRequired;
          if (live.acceptAuthentication(result)) {
            setAccount(result.identity);
            if (resume) void live.retryConnection();
          }
        }
      },
      onError: (error) => {
        if (!alive) return;
        setAuthError(error.message);
        setAccount((value) => (value === undefined ? null : value));
      },
    });
    auth.current = maintenance;
    const onPopState = () => {
      if (authentication.current?.identity) followRoute();
      else home(null, { historyMode: "none", refreshCatalog: false });
    };
    window.addEventListener("popstate", onPopState);
    maintenance.refresh().catch((error) => {
      if (alive) setError(error.message);
    });
    return () => {
      alive = false;
      maintenance.stop();
      window.removeEventListener("popstate", onPopState);
      catalogRevision.current++;
      nextGeneration();
      void current.current?.close();
    };
  }, []);
  const page = session?.snapshot(),
    threads = page?.comments ?? [];
  useEffect(() => {
    if (!titleFocusRequest) return;
    const frame = requestAnimationFrame(() => {
      focusCreatedPageTitle(titleInput.current, titleFocusRequest, current.current);
      setTitleFocusRequest((request) => (request === titleFocusRequest ? null : request));
    });
    return () => cancelAnimationFrame(frame);
  }, [titleFocusRequest, session]);
  useEffect(() => {
    if (!focusBlock || !session?.canWrite) return;
    const frame = requestAnimationFrame(() => {
      if (current.current !== session || !session.canWrite) return;
      const element = article.current?.querySelector(
        `[data-block-id="${CSS.escape(focusBlock)}"] wg-content`,
      );
      if (element) {
        element.focus();
        element.scrollIntoView({ block: "nearest" });
        setFocusBlock(null);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusBlock, session, page?.blocks.length]);
  async function create() {
    if (creationPending.current || current.current?.authRequired) return;
    creationPending.current = true;
    setCreating(true);
    setError("");
    setPickerError("");
    const revision = nextGeneration();
    try {
      const next = await PageSession.create(
        { title: "Untitled" },
        {
          authentication: authentication.current,
          refreshSession: () => auth.current.refresh(),
        },
      );
      if (revision !== generation.current) {
        await next.close();
        return;
      }
      releaseCurrent();
      writePageRoute(next.pageId);
      setPickerOpen(false);
      setOpening(false);
      setNotice("");
      if (await install(next, revision)) setTitleFocusRequest(next);
      void refresh().catch(() => {});
    } catch (error) {
      if (revision === generation.current) {
        setError(error.message);
        setPickerError(error.message);
      }
    } finally {
      creationPending.current = false;
      setCreating(false);
    }
  }
  async function copyLink(pageId = current.current?.pageId) {
    if (!pageId) return;
    try {
      await navigator.clipboard.writeText(new URL(pagePath(pageId), location.origin).href);
      setNotice("Link copied");
      if (documentDisclosure.current) documentDisclosure.current.open = false;
    } catch {
      setError(
        pageId === current.current?.pageId
          ? "Couldn't copy the link. You can copy it from the address bar."
          : "Couldn't copy the link. Open the page and copy its address.",
      );
    }
  }
  async function remove() {
    const deleting = current.current;
    if (!deleting) return;
    if (
      deleting.authRequired ||
      deleting.identity.principal !== authentication.current?.identity?.principal
    ) {
      setError("Sign in with this Page's original account to delete it.");
      return;
    }
    if (!confirm("Delete this Page?")) return;
    try {
      const prepared = await tool("list_pages");
      if (deleting.identity.principal !== authentication.current?.identity?.principal)
        throw Error("Sign in with this Page's original account to delete it.");
      await tool("delete_page", {
        page_id: deleting.pageId,
        expected_principal: deleting.identity.principal,
        retry_token: prepared.retry_token,
        base_heads: A.getHeads(deleting.doc),
        idempotency_key: await retryKey(prepared.retry_token),
      });
      const activeDeletion = current.current?.pageId === deleting.pageId ? current.current : null;
      if (activeDeletion || readPageRoute(location.href).pageId === deleting.pageId) {
        nextGeneration();
        current.current = null;
        resetDocumentUI();
        setSession(null);
        setOpening(false);
        writePageRoute(null, { replace: true });
      }
      await deleting.close();
      if (activeDeletion && activeDeletion !== deleting) await activeDeletion.close();
      await forgetLocalPage(deleting.identity, deleting.pageId);
      await refresh();
    } catch (error) {
      setError(error.message);
    }
  }
  async function signout() {
    try {
      await request("/api/auth/logout", { method: "POST" });
      await current.current?.close();
      location.href = "/";
    } catch (error) {
      setError(error.message);
    }
  }
  function startComment(id, selected) {
    if (!session || !id || !selected) return;
    activateBlock(id);
    if (session.canWrite) {
      try {
        const draft = captureCommentDraft(session.doc, id, selected);
        const key = crypto.randomUUID();
        composerId.current = key;
        setComposer({ key, draft, quote: selected?.text.replaceAll("\ufffc", "\n") || "" });
        setTarget(null);
      } catch (error) {
        setError(error.message);
        return;
      }
    }
    setCommentsOpen(true);
  }
  function closeComments() {
    setCommentsOpen(false);
    requestAnimationFrame(() => commentsButton.current?.focus({ preventScroll: true }));
  }
  function toggleComments() {
    if (commentsOpen) closeComments();
    else setCommentsOpen(true);
  }
  function selectComment(id) {
    setTarget({ id, request: performance.now(), source: "passage" });
    setCommentsOpen(true);
  }
  function revealComment(thread) {
    setTarget({ id: thread.id, request: performance.now(), source: "quote" });
    const id =
      thread.target.kind === "selection" ? thread.target.anchor.blockId : thread.target.blockId;
    if (thread.target.kind === "block" || thread.selectionContext?.status === "detached")
      article.current
        ?.querySelector(`[data-block-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "center" });
  }
  function continueWriting() {
    if (!session || current.current !== session) return;
    try {
      const id = writingContinuation(session);
      if (!id || current.current !== session) return;
      activateBlock(id);
      setFocusBlock(id);
    } catch (error) {
      setError(error.message);
    }
  }
  function revealProgress(passage) {
    const marker = `[data-progress-id="${CSS.escape(passage.progress.progress_id)}"][data-progress-target="${passage.index}"]`;
    const element =
      article.current?.querySelector(marker) ??
      article.current?.querySelector(`[data-block-id="${CSS.escape(passage.block_id)}"]`);
    element?.scrollIntoView({ block: "center", inline: "nearest" });
  }
  useEffect(() => {
    document.title = page ? `${page.title || "Untitled"} · Pages` : "Pages · nteract";
  }, [page?.title]);
  const listedPages = pages.map((item) =>
    item.page_id === page?.page_id ? { ...item, title: page.title } : item,
  );
  const libraryPages = matchingPages(listedPages, libraryQuery);
  const openComments = threads.filter((thread) => thread.state === "open").length;
  return (
    <div className={page ? "app has-document" : "app"} onKeyDownCapture={formattingShortcut}>
      <header className="app-header">
        <div className="header-navigation">
          <a href="/" className="brand" onClick={account ? home : undefined}>
            Pages
          </a>
          {account && (
            <button
              className={`subtle-button pages-trigger${page ? " document-switcher" : ""}`}
              aria-label={`${page?.title || (page ? "Untitled" : "Browse")}, switch page`}
              title="Switch page"
              onClick={() => {
                setPickerError("");
                setPickerOpen(true);
              }}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
            >
              {!page && <FolderOpen size={18} aria-hidden="true" />}
              {!page && <span>Browse</span>}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="header-actions">
          {page && (
            <div className="document-meta">
              <div className="document-status">
                <SaveStatus status={session.status} />
                {["Unsaved", "Offline", "Saved locally"].includes(session.status) && (
                  <button
                    className="subtle-button"
                    onClick={() => session.retryConnection({ retryReceipt: true })}
                  >
                    Retry
                  </button>
                )}
              </div>
              <div className="document-controls">
                <PageActivity
                  key={session.pageId}
                  session={session}
                  disclosure={activityDisclosure}
                  onReveal={revealProgress}
                />
                <SharingControls key={session.pageId} session={session} />
                <button
                  ref={commentsButton}
                  className="subtle-button comments-toggle"
                  aria-label="Comments"
                  aria-describedby="open-comment-count"
                  aria-expanded={commentsOpen}
                  aria-controls="page-comments"
                  onClick={toggleComments}
                >
                  <MessageSquare size={18} aria-hidden="true" />
                  <span>Comments</span>
                  <span id="open-comment-count" className="sr-only">
                    {openComments} open {openComments === 1 ? "comment" : "comments"}
                  </span>
                  {openComments > 0 && <span className="comment-count">{openComments}</span>}
                </button>
                {
                  <details className="document-actions" ref={documentDisclosure}>
                    <summary
                      className="icon-button"
                      aria-label="Document actions"
                      title="Document actions"
                    >
                      <MoreHorizontal size={20} aria-hidden="true" />
                    </summary>
                    <div className="menu-popover">
                      {session.canWrite && (
                        <button
                          aria-expanded={toolbarOpen}
                          aria-controls="page-formatting"
                          aria-keyshortcuts="Alt+F10"
                          onClick={() => {
                            showFormatting(!toolbarOpen, !toolbarOpen);
                            if (toolbarOpen)
                              documentDisclosure.current?.querySelector("summary")?.focus();
                          }}
                        >
                          <Type size={16} aria-hidden="true" />
                          {toolbarOpen ? "Hide formatting" : "Show formatting"}
                          <kbd>Alt F10</kbd>
                        </button>
                      )}
                      <button onClick={() => copyLink()}>
                        <Link size={16} aria-hidden="true" /> Copy link
                      </button>
                      {localRecoveries.length > 0 && (
                        <button onClick={() => downloadDraft(localRecoveries.at(-1))}>
                          Download previous local draft
                        </button>
                      )}
                      {session.canDelete && (
                        <button className="danger" onClick={remove}>
                          <Trash2 size={16} aria-hidden="true" /> Delete
                        </button>
                      )}
                    </div>
                  </details>
                }
              </div>
            </div>
          )}
          {account && (
            <details className="account-actions" ref={accountDisclosure}>
              <summary
                className="icon-button"
                aria-label="Account"
                title={account.displayName || "Account"}
              >
                <UserRound size={19} aria-hidden="true" />
              </summary>
              <div className="menu-popover">
                <p className="account-name">{account.displayName || "Your workspace"}</p>
                <AppearanceControls />
                <a
                  href="/connect"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    accountDisclosure.current.open = false;
                  }}
                >
                  <Plug size={16} aria-hidden="true" /> Connect an agent
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <button onClick={signout}>
                  <LogOut size={16} aria-hidden="true" /> Sign out
                </button>
              </div>
            </details>
          )}
        </div>
      </header>
      {page && <div id="page-formatting" className="toolbar-host" ref={setToolbar} />}
      {error && (
        <p role="alert" className="error app-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="app-notice" role="status">
          {notice}
        </p>
      )}
      {authError && (
        <p role="alert" className="error app-error">
          {authError}
        </p>
      )}
      {account === undefined ? (
        <main className="welcome">
          <p role="status">Connecting…</p>
        </main>
      ) : !account ? (
        <main className="welcome">
          <h1>A place to write together.</h1>
          <a
            className="primary"
            href={`/api/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}
          >
            Sign In
          </a>
        </main>
      ) : (
        <>
          <PagePicker
            open={pickerOpen}
            pages={listedPages}
            currentId={page?.page_id}
            onClose={() => setPickerOpen(false)}
            onOpen={open}
            onCreate={create}
            creating={creating || !!session?.authRequired}
            error={pickerError}
          />
          {page ? (
            <main
              className={commentsOpen ? "workspace document with-comments" : "workspace document"}
            >
              <article ref={article}>
                <h1 className="document-print-title sr-only">{page.title || "Untitled"}</h1>
                {session.authRequired && (
                  <p className="error" role="alert">
                    {session.authProblem}{" "}
                    <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
                      Sign in
                    </a>{" "}
                    <button onClick={() => session.retryConnection({ retryReceipt: true })}>
                      Retry connection
                    </button>
                  </p>
                )}
                {session.accessProblem && (
                  <div className="access-notice" role="status">
                    <p>{session.accessProblem}</p>
                    <button onClick={() => downloadDraft()}>Download local draft</button>
                    {session.accessReloadRequired && (
                      <button onClick={() => reloadAccess()}>Reload current Page</button>
                    )}
                  </div>
                )}
                {session.problem && (
                  <p className="error" role="alert">
                    {session.problem}
                  </p>
                )}
                <input
                  ref={titleInput}
                  className="document-title"
                  aria-label="Page title"
                  title={page.title || "Untitled"}
                  placeholder="Untitled"
                  value={page.title}
                  readOnly={!session.canWrite}
                  onChange={(event) => {
                    try {
                      session.change((doc) => A.updateText(doc, ["title"], event.target.value));
                    } catch (error) {
                      setError(error.message);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!titleHandsOffToBody(event, session.canWrite)) return;
                    event.preventDefault();
                    const first = orderedBlockIds(session.doc)[0];
                    if (first) {
                      activateBlock(first);
                      setFocusBlock(first);
                    } else continueWriting();
                  }}
                />
                {page.blocks.map((block) => (
                  <section className="page-block" data-block-id={block.id} key={block.id}>
                    {block.format === "automerge-rich-text-v1" ? (
                      <WordgardEditor
                        replica={session}
                        id={block.id}
                        editable={session.canWrite}
                        onError={setError}
                        onComment={(selected) => startComment(block.id, selected)}
                        onRevealComment={selectComment}
                        toolbarHost={active === block.id ? toolbar : null}
                        toolbarOpen={toolbarOpen}
                        onActivate={() => activateBlock(block.id)}
                        threads={threads}
                        commentTarget={target}
                      />
                    ) : (
                      <pre>{block.markdown ?? "Unsupported block"}</pre>
                    )}
                  </section>
                ))}
                {session.canWrite && (
                  <button type="button" className="writing-continuation" onClick={continueWriting}>
                    Write something…
                  </button>
                )}
              </article>
              <CommentsPanel
                key={session.pageId}
                open={commentsOpen}
                session={session}
                threads={threads}
                composer={composer}
                target={target}
                onClose={closeComments}
                onReveal={revealComment}
                onSelect={selectComment}
                onClearComposer={(key) => {
                  if (composerId.current === key) {
                    composerId.current = null;
                    setComposer(null);
                  }
                }}
              />
            </main>
          ) : opening ? (
            <main className="welcome">
              <p role="status">Opening…</p>
            </main>
          ) : (
            <main className="page-library">
              <div className="library-heading">
                <h1>Your pages</h1>
                <button className="primary" onClick={create} disabled={creating}>
                  <Plus size={18} aria-hidden="true" /> New Page
                </button>
              </div>
              <label className="picker-search library-search">
                <Search size={18} aria-hidden="true" />
                <input
                  aria-label="Search your pages"
                  placeholder="Search pages"
                  value={libraryQuery}
                  onChange={(event) => setLibraryQuery(event.target.value)}
                  type="search"
                />
              </label>
              {!pages.length && <p className="muted">Start a page and write together.</p>}
              {!!pages.length && !libraryPages.length && (
                <p className="muted">No matching pages.</p>
              )}
              <ul className="page-list page-cards" aria-label="Your pages">
                {libraryPages.map((item) => (
                  <li className="page-row" key={item.page_id}>
                    <a
                      className="page-card"
                      href={pagePath(item.page_id)}
                      onClick={(event) => {
                        if (isPlainNavigation(event)) {
                          event.preventDefault();
                          void open(item.page_id);
                        }
                      }}
                    >
                      <FileText size={19} aria-hidden="true" />
                      <span className="page-card-title">{item.title || "Untitled"}</span>
                      {item.pending && <span className="page-card-meta">Saved locally</span>}
                    </a>
                    <button
                      className="icon-button page-row-action"
                      aria-label={`Copy link to ${item.title || "Untitled"}`}
                      title="Copy link"
                      onClick={() => copyLink(item.page_id)}
                    >
                      <Link size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </main>
          )}
        </>
      )}
    </div>
  );
}

function useDismissibleDisclosure() {
  const disclosure = useRef(null);
  useEffect(() => {
    const dismissOutside = (event) => {
      const element = disclosure.current;
      if (element?.open && !element.contains(event.target)) element.open = false;
    };
    const dismissEscape = (event) => {
      const element = disclosure.current;
      if (event.key !== "Escape" || !element?.open) return;
      event.preventDefault();
      element.open = false;
      element.querySelector("summary")?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, []);
  return disclosure;
}

createRoot(document.getElementById("root")).render(<App />);
