import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ProjectedMarkdownView } from "../../../src/components/markdown/ProjectedMarkdownView";
import {
  projectMarkdownPlan,
  canRenderMarkdownProjectionInHost,
} from "../../../src/lib/markdown-projection";
import { initializeMarkdown } from "./markdown";
import { store, ToolError } from "./store";
import { openPageLink } from "./links";
import type { Snapshot } from "../src/document";
import "./style.css";

interface Draft {
  owner?: string;
  pending?: boolean;
  page: Snapshot;
  id: string | null;
  kind: "markdown" | "agent_instructions";
  source: string;
  key: string;
  title?: boolean;
}
function Markdown({ source }: { source: string }) {
  if (!source.trim()) return null;
  const plan = projectMarkdownPlan(source);
  return plan && canRenderMarkdownProjectionInHost(plan) ? (
    <ProjectedMarkdownView plan={plan} colorTheme="cream" onLinkClick={openPageLink} />
  ) : (
    <pre>{source}</pre>
  );
}
function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const actionVersion = useRef(0);
  useEffect(() => {
    actionVersion.current++;
    setBusy(false);
    setError("");
    setLatest(null);
    setConflict(false);
    if (!state.accountKey) return;
    let recovered: Draft | null = null;
    try {
      const value = JSON.parse(sessionStorage.getItem(`pages:draft:${state.accountKey}`) || "null");
      if (
        value?.owner === state.accountKey &&
        typeof value.source === "string" &&
        Array.isArray(value.page?.blocks)
      )
        recovered = value;
    } catch {
      /* A malformed local draft must not prevent opening the workspace. */
    }
    setDraft(recovered);
    setUncertain(recovered?.pending === true);
    setConflict(false);
    setLatest(null);
  }, [state.accountKey]);
  useEffect(() => {
    void store.refresh();
    const timer = setInterval(() => void store.refresh(), 15000);
    return () => clearInterval(timer);
  }, []);
  async function run(action: () => Promise<unknown>) {
    const version = ++actionVersion.current;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (version === actionVersion.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (version === actionVersion.current) setBusy(false);
    }
  }
  function start(d: Draft) {
    remember({ ...d, owner: state.accountKey ?? undefined });
    setUncertain(false);
    setConflict(false);
    setLatest(null);
    setError("");
  }
  function remember(d: Draft) {
    setDraft(d);
    if (d.owner) {
      try {
        sessionStorage.setItem(`pages:draft:${d.owner}`, JSON.stringify(d));
      } catch {
        setError("This browser cannot retain the draft through a reload. Copy it before leaving.");
      }
    }
  }
  function clearDraft() {
    if (draft?.owner) sessionStorage.removeItem(`pages:draft:${draft.owner}`);
    setDraft(null);
    setUncertain(false);
    setConflict(false);
    setLatest(null);
  }
  function downloadDraft() {
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([draft.source], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "page-draft.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function save() {
    if (!draft) return;
    const current = draft.page.blocks.find((b) => b.id === draft.id);
    const op = draft.title
      ? { op: "set_title", expected_title_hash: draft.page.title_hash, title: draft.source }
      : current
        ? {
            op: "replace_block_markdown",
            block_id: current.id,
            expected_hash: current.hash,
            markdown: draft.source,
          }
        : {
            op: "insert_markdown",
            at: {
              kind: "between_blocks",
              preceding_block_id: draft.page.blocks.at(-1)?.id ?? null,
              following_block_id: null,
            },
            block_units: [{ kind: draft.kind, markdown: draft.source }],
          };
    if (draft.owner !== store.getSnapshot().accountKey)
      throw new Error("Sign in to the account that owns this draft");
    setUncertain(true);
    remember({ ...draft, pending: true });
    try {
      await store.tool("edit_page", {
        page_id: draft.page.page_id,
        base_sequence: draft.page.through_sequence,
        idempotency_key: draft.key,
        operations: [op],
      });
    } catch (error) {
      if (draft.owner !== store.getSnapshot().accountKey) return;
      if (error instanceof ToolError && error.commitStatus === "not_committed") {
        setUncertain(false);
        remember({ ...draft, pending: false });
        setConflict(error.status === 409);
      }
      throw error;
    }
    if (draft.owner !== store.getSnapshot().accountKey) return;
    clearDraft();
    await store.refresh();
  }
  const page = state.page;
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          nteract<span>pages</span>
        </a>
        <p className="eyebrow">PERSONAL WORKSPACE</p>
        {state.signedIn && (
          <>
            <button
              className="new-page"
              disabled={busy || !!draft}
              onClick={() => void run(() => store.create())}
            >
              ＋ New page
            </button>
            <nav>
              {state.pages.map((p) => (
                <button
                  key={p.page_id}
                  className={p.page_id === page?.page_id ? "selected" : ""}
                  disabled={!!draft}
                  onClick={() => void run(() => store.open(p.page_id))}
                >
                  {p.title || "Untitled"}
                </button>
              ))}
            </nav>
            <footer>
              <span>{state.name}</span>
              <button disabled={busy || !!draft} onClick={() => void run(() => store.signOut())}>
                Sign out
              </button>
            </footer>
          </>
        )}
      </aside>
      <main>
        {(error || state.error) && (
          <div className="notice" role="alert">
            {error || state.error}
          </div>
        )}
        {!state.signedIn && draft && (
          <section className="recovery">
            <h2>Your unsaved draft is still here</h2>
            <p>Sign in to the same account to recover it. You can also save a copy now.</p>
            <textarea aria-label="Recovered draft" readOnly value={draft.source} />
            <button onClick={downloadDraft}>Download draft</button>
          </section>
        )}
        {!state.ready ? (
          <p className="empty">Opening your workspace…</p>
        ) : !state.signedIn ? (
          <section className="welcome">
            <p className="eyebrow">A SHARED PLACE FOR YOUR THINKING</p>
            <h1>
              Thoughts, with room
              <br />
              to become something.
            </h1>
            <p>
              Write in Markdown. Keep your documents with you.
              <br />
              Work on the same pages across your devices and tools.
            </p>
            <a
              className="primary"
              href={`/api/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}
            >
              Sign in
            </a>
            <small>Your workspace is private to your account.</small>
          </section>
        ) : !page ? (
          <section className="welcome">
            <h1>A place to begin.</h1>
            <p>Create your first page for notes, a proposal, or a plan.</p>
            <button className="primary" onClick={() => void run(() => store.create())}>
              Create a page
            </button>
          </section>
        ) : (
          <>
            <header>
              <span>
                Personal <span className="slash">/</span> {page.title || "Untitled"}
              </span>
              <span className="saved">{busy ? "Saving…" : draft ? "Unsaved draft" : "Saved"}</span>
            </header>
            <article>
              <p className="eyebrow">PAGE</p>
              <div className="page-title">
                <h1>{page.title || "Untitled"}</h1>
                <button
                  disabled={!!draft}
                  onClick={() =>
                    start({
                      page,
                      id: null,
                      kind: "markdown",
                      source: page.title,
                      title: true,
                      key: crypto.randomUUID(),
                    })
                  }
                >
                  Rename
                </button>
              </div>
              {page.blocks.map((b) => (
                <section
                  className={`block ${b.kind === "agent_instructions" ? "instructions" : ""}`}
                  key={b.id}
                >
                  <div className="block-tools">
                    {b.kind === "agent_instructions" && <span>Agent instructions</span>}
                    <button
                      disabled={!!draft}
                      onClick={() =>
                        start({
                          page,
                          id: b.id,
                          kind: b.kind,
                          source: b.markdown,
                          key: crypto.randomUUID(),
                        })
                      }
                    >
                      Edit
                    </button>
                  </div>
                  <Markdown source={b.markdown} />
                </section>
              ))}
              {draft ? (
                <form
                  className="editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(save);
                  }}
                >
                  <label htmlFor="source">{draft.title ? "Page title" : "Markdown source"}</label>
                  <textarea
                    id="source"
                    autoFocus
                    rows={draft.title ? 2 : 9}
                    value={draft.source}
                    readOnly={busy || uncertain}
                    onChange={(e) =>
                      remember({
                        ...draft,
                        source: e.target.value,
                        key: crypto.randomUUID(),
                        pending: false,
                      })
                    }
                  />
                  <div className="editor-actions">
                    <button type="submit" className="primary" disabled={busy || conflict}>
                      {uncertain ? "Retry save" : "Save"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        clearDraft();
                        setError("");
                        void store.refresh();
                      }}
                    >
                      Cancel
                    </button>
                    <button type="button" onClick={downloadDraft}>
                      Download draft
                    </button>
                    {conflict && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await store.tool<{ content: Snapshot }>("read_page", {
                              page_id: draft.page.page_id,
                            });
                            if (store.getSnapshot().accountKey === draft.owner)
                              setLatest(result.content);
                          })
                        }
                      >
                        Compare with saved page
                      </button>
                    )}
                  </div>
                  {latest && (
                    <section className="comparison">
                      <h3>Current saved version</h3>
                      <pre>
                        {draft.title
                          ? latest.title
                          : draft.id
                            ? (latest.blocks.find((b) => b.id === draft.id)?.markdown ??
                              "This block was deleted.")
                            : "Your new block will be appended to the current page."}
                      </pre>
                      <p>Merge the saved changes into your draft above before saving.</p>
                      <button
                        type="button"
                        disabled={!!draft.id && !latest.blocks.some((b) => b.id === draft.id)}
                        onClick={() => {
                          remember({
                            ...draft,
                            page: latest,
                            key: crypto.randomUUID(),
                            pending: false,
                          });
                          setConflict(false);
                          setLatest(null);
                          setError("");
                        }}
                      >
                        Use saved version as base
                      </button>
                    </section>
                  )}
                  {uncertain && (
                    <p className="hint">
                      The save outcome is unknown. Your draft is selectable and retained in this
                      tab. Retry the same save before changing it, or download a copy.
                    </p>
                  )}
                </form>
              ) : (
                <div className="append">
                  <button
                    onClick={() =>
                      start({
                        page,
                        id: null,
                        kind: "markdown",
                        source: "",
                        key: crypto.randomUUID(),
                      })
                    }
                  >
                    ＋ Add a block
                  </button>
                  <button
                    onClick={() =>
                      start({
                        page,
                        id: null,
                        kind: "agent_instructions",
                        source: "",
                        key: crypto.randomUUID(),
                      })
                    }
                  >
                    Add instructions
                  </button>
                </div>
              )}
              <div className="page-bottom">
                Markdown, kept together.<span>Updated across your devices</span>
              </div>
            </article>
          </>
        )}
      </main>
    </div>
  );
}
initializeMarkdown()
  .then(() => createRoot(document.getElementById("root")!).render(<App />))
  .catch((error) => {
    document.getElementById("root")!.textContent = String(error);
  });
