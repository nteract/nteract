import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as A from "@automerge/automerge";
import { PageSession, request, tool } from "./session.mjs";
import { RichEditor } from "./RichEditor.jsx";
import { applyPageOperation } from "../model/page.mjs";
import "./style.css";

function App() {
  const [account, setAccount] = useState(undefined),
    [pages, setPages] = useState([]),
    [session, setSession] = useState(null),
    [, paint] = useState(0),
    [error, setError] = useState("");
  const [toolbar, setToolbar] = useState(null),
    [active, setActive] = useState(null),
    [selection, setSelection] = useState(null),
    [commentsOpen, setCommentsOpen] = useState(false),
    [target, setTarget] = useState(null);
  const current = useRef(null),
    generation = useRef(0);
  const refresh = async () => {
    const result = await tool("list_pages");
    setPages(result.pages);
    return result.pages;
  };
  async function open(id) {
    const revision = ++generation.current;
    setError("");
    setSession(null);
    const old = current.current;
    current.current = null;
    await old?.close();
    try {
      const next = await PageSession.open(id);
      if (revision !== generation.current) {
        await next.close();
        return;
      }
      current.current = next;
      setSession(next);
      next.subscribe(() => paint((n) => n + 1));
      history.replaceState(null, "", `?page=${encodeURIComponent(id)}`);
      setActive(next.doc.order[0]);
      setSelection(null);
    } catch (e) {
      if (revision === generation.current) setError(e.message);
    }
  }
  useEffect(() => {
    let alive = true;
    request("/api/auth/session")
      .then(async (result) => {
        if (!alive) return;
        setAccount(result.identity);
        if (result.identity) {
          const list = await refresh();
          const id = new URL(location.href).searchParams.get("page");
          if (alive && id && list.some((p) => p.page_id === id)) await open(id);
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      alive = false;
      generation.current++;
      void current.current?.close();
    };
  }, []);
  async function create() {
    try {
      const result = await tool("create_page", {
        title: "Untitled",
        markdown: "",
        idempotency_key: crypto.randomUUID(),
      });
      await refresh();
      await open(result.page_id);
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove() {
    if (!session || !confirm("Delete this Page?")) return;
    try {
      await tool("delete_page", {
        page_id: session.pageId,
        base_heads: A.getHeads(session.doc),
        idempotency_key: crypto.randomUUID(),
      });
      generation.current++;
      await session.close();
      current.current = null;
      setSession(null);
      history.replaceState(null, "", "/");
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }
  async function signout() {
    await request("/api/auth/logout", { method: "POST" });
    await current.current?.close();
    location.href = "/";
  }
  const page = session?.snapshot(),
    threads = page?.comments ?? [];
  const showComments = (id) => {
    setActive(id);
    setCommentsOpen(true);
  };
  return (
    <div className="app">
      <header>
        <a href="/" className="brand">
          Pages
        </a>
        <div className="header-actions">
          {account && (
            <>
              <span>{account.displayName ?? "Your workspace"}</span>
              <button onClick={signout}>Sign out</button>
            </>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {account === undefined ? (
        <main>Connecting…</main>
      ) : !account ? (
        <main className="welcome">
          <h1>A place to write together.</h1>
          <a className="primary" href="/api/auth/login">
            Sign in with Anaconda
          </a>
        </main>
      ) : (
        <>
          <nav className="page-list" aria-label="Pages">
            <button className="primary" onClick={create}>
              New Page
            </button>
            {pages.map((p) => (
              <button
                key={p.page_id}
                aria-current={session?.pageId === p.page_id ? "page" : undefined}
                onClick={() => open(p.page_id)}
              >
                {p.page_id === page?.page_id ? page.title : p.title || "Untitled"}
              </button>
            ))}
          </nav>
          {page ? (
            <main className={commentsOpen ? "document with-comments" : "document"}>
              <article>
                <div className="document-meta">
                  <span role="status">
                    {session.status}
                    {session.status === "Unsaved" && (
                      <button onClick={() => session.saveReceipt()}>Retry</button>
                    )}
                  </span>
                  <div>
                    <button onClick={() => setCommentsOpen((v) => !v)}>
                      Comments {threads.filter((t) => t.state === "open").length || ""}
                    </button>
                    {session.canWrite && <button onClick={remove}>Delete</button>}
                  </div>
                </div>
                {session.problem && (
                  <p className="error" role="alert">
                    {session.problem}
                  </p>
                )}
                <input
                  className="title"
                  aria-label="Page title"
                  value={page.title}
                  readOnly={!session.canWrite}
                  onChange={(e) => {
                    try {
                      session.change((d) => A.updateText(d, ["title"], e.target.value));
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                />
                <div className="toolbar-host" ref={setToolbar} />
                {page.blocks.map((block) => (
                  <section className="page-block" key={block.id}>
                    {block.format === "automerge-rich-text-v1" ? (
                      <RichEditor
                        replica={session}
                        id={block.id}
                        editable={session.canWrite}
                        onError={setError}
                        onSelection={(value) => {
                          if (active === block.id) setSelection(value);
                        }}
                        toolbarHost={active === block.id ? toolbar : null}
                        onActivate={() => setActive(block.id)}
                        threads={threads}
                        commentTarget={target}
                      />
                    ) : (
                      <pre>{block.markdown ?? "Unsupported block"}</pre>
                    )}
                    <button
                      className="comment-block"
                      onClick={() => showComments(block.id)}
                      aria-label="Comment on this block"
                    >
                      Comment
                    </button>
                  </section>
                ))}
                {session.canWrite && (
                  <button
                    className="add-block"
                    onClick={() =>
                      session.change((d) =>
                        applyPageOperation(d, {
                          operation: "edit_page",
                          arguments: { operations: [{ op: "insert_markdown", markdown: "" }] },
                        }),
                      )
                    }
                  >
                    + Block
                  </button>
                )}
              </article>
              {commentsOpen && (
                <aside className="comments">
                  <div className="comments-heading">
                    <h2>Comments</h2>
                    <button aria-label="Close comments" onClick={() => setCommentsOpen(false)}>
                      ×
                    </button>
                  </div>
                  {session.canWrite && active && (
                    <CommentForm
                      label={selection ? "Comment on selection" : "Comment on block"}
                      submit={(body) =>
                        session.comment({
                          action: "add",
                          block_id: active,
                          body,
                          selected_text: selection?.text,
                          occurrence: selection?.occurrence,
                        })
                      }
                      onError={setError}
                    />
                  )}
                  {!threads.length && <p className="muted">Select a passage to leave a comment.</p>}
                  {threads.map((thread) => (
                    <div
                      className={"thread " + (thread.state === "resolved" ? "resolved" : "")}
                      key={thread.id}
                    >
                      {thread.selectionContext?.text && (
                        <button
                          className="quote"
                          onClick={() => setTarget({ id: thread.id, request: Date.now() })}
                        >
                          {thread.selectionContext.text}
                        </button>
                      )}
                      {thread.selectionContext?.status === "detached" && (
                        <p className="muted">Passage removed</p>
                      )}
                      {thread.messages.map((message) =>
                        message.deletedAt ? null : (
                          <div className="message" key={message.id}>
                            <strong title="Comment author label stored in the document">
                              {message.author?.displayName || "Collaborator"}
                            </strong>
                            <span className="muted"> {message.author?.driver}</span>
                            <p>{message.body}</p>
                          </div>
                        ),
                      )}
                      {session.canWrite && (
                        <>
                          <button
                            onClick={() =>
                              session.comment({
                                action: thread.state === "open" ? "resolve" : "reopen",
                                thread_id: thread.id,
                              })
                            }
                          >
                            {thread.state === "open" ? "Resolve" : "Reopen"}
                          </button>
                          {thread.state === "open" && (
                            <CommentForm
                              label="Reply"
                              submit={(body) =>
                                session.comment({ action: "reply", thread_id: thread.id, body })
                              }
                              onError={setError}
                            />
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </aside>
              )}
            </main>
          ) : (
            <main className="welcome">
              <h1>Make room for an idea.</h1>
              <p>Open a Page or start a new one.</p>
            </main>
          )}
        </>
      )}
    </div>
  );
}
function CommentForm({ label, submit, onError }) {
  const [body, setBody] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await submit(body);
          setBody("");
        } catch (error) {
          onError(error.message);
        }
      }}
    >
      <label>
        {label}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={16000}
        />
      </label>
      <button disabled={!body.trim()}>Send</button>
    </form>
  );
}
createRoot(document.getElementById("root")).render(<App />);
