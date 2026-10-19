import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as A from "@automerge/automerge";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react";
import { PageSession, request, tool } from "./session.mjs";
import { maintainBrowserSession } from "./browser-session.mjs";
import { RichEditor } from "./RichEditor.jsx";
import { PagePicker } from "./PagePicker.jsx";
import { CommentsPanel } from "./CommentsPanel.jsx";
import { captureCommentDraft } from "./comment-draft.mjs";
import { applyPageOperation } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import "./style.css";

function App() {
  const accountDisclosure = useDismissibleDisclosure(),
    documentDisclosure = useDismissibleDisclosure();
  const [account, setAccount] = useState(undefined),
    [pages, setPages] = useState([]),
    [session, setSession] = useState(null),
    [, paint] = useState(0),
    [error, setError] = useState(""),
    [authError, setAuthError] = useState("");
  const [toolbar, setToolbar] = useState(null),
    [active, setActive] = useState(null),
    [commentsOpen, setCommentsOpen] = useState(false),
    [composer, setComposer] = useState(null),
    [target, setTarget] = useState(null),
    [pickerOpen, setPickerOpen] = useState(false),
    [pickerError, setPickerError] = useState(""),
    [creating, setCreating] = useState(false),
    [opening, setOpening] = useState(false),
    [focusBlock, setFocusBlock] = useState(null);
  const current = useRef(null),
    auth = useRef(null),
    generation = useRef(0),
    activeBlock = useRef(null),
    composerId = useRef(null),
    selection = useRef(null),
    article = useRef(null),
    commentsButton = useRef(null);
  const refresh = async () => {
    const result = await tool("list_pages");
    setPages(result.pages);
    return result.pages;
  };
  function activateBlock(id) {
    if (activeBlock.current !== id) selection.current = null;
    activeBlock.current = id;
    setActive(id);
  }
  function resetDocumentUI() {
    activeBlock.current = null;
    selection.current = null;
    setActive(null);
    composerId.current = null;
    setComposer(null);
    setTarget(null);
    setCommentsOpen(false);
    setFocusBlock(null);
  }
  async function open(id, { focus = false } = {}) {
    const revision = ++generation.current;
    setError("");
    setOpening(true);
    resetDocumentUI();
    setSession(null);
    const old = current.current;
    current.current = null;
    try {
      await old?.close();
      if (revision !== generation.current) return;
      const next = await PageSession.open(id, { refreshSession: () => auth.current.refresh() });
      if (revision !== generation.current) {
        await next.close();
        return;
      }
      current.current = next;
      setSession(next);
      next.subscribe(() => paint((n) => n + 1));
      history.replaceState(null, "", `?page=${encodeURIComponent(id)}`);
      const first = orderedBlockIds(next.doc)[0] ?? null;
      activateBlock(first);
      if (focus) setFocusBlock(first);
    } catch (error) {
      if (revision === generation.current) setError(error.message);
    } finally {
      if (revision === generation.current) setOpening(false);
    }
  }
  async function home(event) {
    event.preventDefault();
    generation.current++;
    const old = current.current;
    current.current = null;
    resetDocumentUI();
    setOpening(false);
    setSession(null);
    history.replaceState(null, "", "/");
    try {
      await old?.close();
      await refresh();
    } catch (error) {
      setError(error.message);
    }
  }
  useEffect(() => {
    let alive = true;
    const maintenance = maintainBrowserSession({
      request: () => request("/api/auth/session"),
      onSession: (result) => {
        if (!alive) return;
        setAuthError("");
        const live = current.current;
        if (!live) setAccount(result.identity);
        else {
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
    maintenance
      .refresh()
      .then(async (result) => {
        if (!alive || !result?.identity) return;
        const list = await refresh();
        const id = new URL(location.href).searchParams.get("page");
        if (alive && id && list.some((page) => page.page_id === id)) await open(id);
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
      maintenance.stop();
      generation.current++;
      void current.current?.close();
    };
  }, []);
  const page = session?.snapshot(),
    threads = page?.comments ?? [];
  useEffect(() => {
    if (!focusBlock || !session?.canWrite) return;
    const frame = requestAnimationFrame(() => {
      const element = article.current?.querySelector(
        `[data-block-id="${CSS.escape(focusBlock)}"] .ProseMirror`,
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
    if (creating) return;
    setCreating(true);
    setError("");
    setPickerError("");
    try {
      const result = await tool("create_page", {
        title: "Untitled",
        markdown: "",
        idempotency_key: crypto.randomUUID(),
      });
      await refresh();
      setPickerOpen(false);
      await open(result.page_id, { focus: true });
    } catch (error) {
      setError(error.message);
      setPickerError(error.message);
    } finally {
      setCreating(false);
    }
  }
  async function remove() {
    const deleting = current.current;
    if (!deleting || !confirm("Delete this Page?")) return;
    try {
      await tool("delete_page", {
        page_id: deleting.pageId,
        base_heads: A.getHeads(deleting.doc),
        idempotency_key: crypto.randomUUID(),
      });
      if (current.current === deleting) {
        generation.current++;
        current.current = null;
        resetDocumentUI();
        setSession(null);
        history.replaceState(null, "", "/");
      }
      await deleting.close();
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
  function startComment(id = activeBlock.current) {
    if (!session) return;
    if (!id) {
      setCommentsOpen(true);
      return;
    }
    const selected = id === activeBlock.current ? selection.current : null;
    activateBlock(id);
    if (session.canWrite) {
      try {
        const draft = captureCommentDraft(session.doc, id, selected);
        const key = crypto.randomUUID();
        composerId.current = key;
        setComposer({ key, draft, quote: selected?.text.replaceAll("\ufffc", "\n") || "" });
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
    else if (composer) setCommentsOpen(true);
    else startComment();
  }
  function revealComment(thread) {
    setTarget({ id: thread.id, request: Date.now() });
    const id =
      thread.target.kind === "selection" ? thread.target.anchor.blockId : thread.target.blockId;
    if (thread.target.kind === "block" || thread.selectionContext?.status === "detached")
      article.current
        ?.querySelector(`[data-block-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "center" });
  }
  function addBlock() {
    try {
      let id;
      session.change((doc) => {
        applyPageOperation(doc, {
          operation: "edit_page",
          arguments: { operations: [{ op: "insert_markdown", markdown: "" }] },
        });
        id = orderedBlockIds(doc).at(-1);
      });
      activateBlock(id);
      setFocusBlock(id);
    } catch (error) {
      setError(error.message);
    }
  }
  const listedPages = pages.map((item) =>
    item.page_id === page?.page_id ? { ...item, title: page.title } : item,
  );
  const openComments = threads.filter((thread) => thread.state === "open").length;
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-navigation">
          <a href="/" className="brand" onClick={account ? home : undefined}>
            Pages
          </a>
          {account && (
            <button
              className="subtle-button pages-trigger"
              onClick={() => {
                setPickerError("");
                setPickerOpen(true);
              }}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
            >
              <FolderOpen size={18} aria-hidden="true" />
              <span>Pages</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="header-actions">
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
                <button onClick={signout}>
                  <LogOut size={16} aria-hidden="true" /> Sign out
                </button>
              </div>
            </details>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="error app-error">
          {error}
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
          <a className="primary" href="/api/auth/login">
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
            creating={creating}
            error={pickerError}
          />
          {page ? (
            <main
              className={commentsOpen ? "workspace document with-comments" : "workspace document"}
            >
              <article ref={article}>
                <div className="document-meta">
                  <div className="document-status">
                    <span role="status">{session.status}</span>
                    {session.status === "Unsaved" && (
                      <button className="subtle-button" onClick={() => session.saveReceipt()}>
                        Retry
                      </button>
                    )}
                  </div>
                  <div className="document-controls">
                    <EditingPresence session={session} />
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
                    {session.canWrite && (
                      <details className="document-actions" ref={documentDisclosure}>
                        <summary
                          className="icon-button"
                          aria-label="Document actions"
                          title="Document actions"
                        >
                          <MoreHorizontal size={20} aria-hidden="true" />
                        </summary>
                        <div className="menu-popover">
                          <button className="danger" onClick={remove}>
                            <Trash2 size={16} aria-hidden="true" /> Delete
                          </button>
                        </div>
                      </details>
                    )}
                  </div>
                </div>
                {session.authRequired && (
                  <p className="error" role="alert">
                    {session.authProblem}{" "}
                    <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
                      Sign in
                    </a>{" "}
                    <button onClick={() => session.retryConnection()}>Retry connection</button>
                  </p>
                )}
                {session.problem && (
                  <p className="error" role="alert">
                    {session.problem}
                  </p>
                )}
                <div className="document-heading">
                  <input
                    className="title"
                    aria-label="Page title"
                    value={page.title}
                    readOnly={!session.canWrite}
                    onChange={(event) => {
                      try {
                        session.change((doc) => A.updateText(doc, ["title"], event.target.value));
                      } catch (error) {
                        setError(error.message);
                      }
                    }}
                  />
                </div>
                <div className="toolbar-host" ref={setToolbar} />
                {page.blocks.map((block) => (
                  <section className="page-block" data-block-id={block.id} key={block.id}>
                    {block.format === "automerge-rich-text-v1" ? (
                      <RichEditor
                        replica={session}
                        id={block.id}
                        editable={session.canWrite}
                        onError={setError}
                        onSelection={(value) => {
                          if (activeBlock.current === block.id) selection.current = value;
                        }}
                        toolbarHost={active === block.id ? toolbar : null}
                        onActivate={() => activateBlock(block.id)}
                        threads={threads}
                        commentTarget={target}
                      />
                    ) : (
                      <pre>{block.markdown ?? "Unsupported block"}</pre>
                    )}
                    <button
                      className="comment-block icon-button"
                      onClick={() => startComment(block.id)}
                      aria-label="Comment on this block"
                      title="Comment on this block"
                    >
                      <MessageSquare size={17} aria-hidden="true" />
                    </button>
                  </section>
                ))}
                {session.canWrite && (
                  <button className="add-block subtle-button" onClick={addBlock}>
                    <Plus size={17} aria-hidden="true" /> Block
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
              {!pages.length && <p className="muted">Start a page and write together.</p>}
              <div className="page-cards">
                {listedPages.map((item) => (
                  <button
                    className="page-card"
                    key={item.page_id}
                    onClick={() => open(item.page_id)}
                  >
                    <FileText size={23} aria-hidden="true" />
                    <span className="page-card-title">{item.title || "Untitled"}</span>
                    <span className="page-card-meta">Open page</span>
                  </button>
                ))}
              </div>
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

function EditingPresence({ session }) {
  const [, update] = useState(0);
  useEffect(() => {
    const paint = () => update((value) => value + 1);
    const stop = session.watchPresence(paint);
    const timer = setInterval(paint, 1000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [session]);
  const peers = [...session.peers].filter(([, peer]) => Date.now() - peer.at <= 30000);
  if (!peers.length) return null;
  return (
    <div
      className="peer-avatars"
      role="group"
      aria-label={
        "Editing: " + peers.map(([, peer]) => peer.displayName || "Collaborator").join(", ")
      }
    >
      <span className="presence-label">Editing</span>
      {peers.slice(0, 3).map(([id, peer]) => (
        <span
          className="avatar"
          key={id}
          title={peer.displayName || "Collaborator"}
          aria-label={peer.displayName || "Collaborator"}
        >
          {(peer.displayName || "C").slice(0, 1).toLocaleUpperCase()}
        </span>
      ))}
      {peers.length > 3 && <span className="avatar">+{peers.length - 3}</span>}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
