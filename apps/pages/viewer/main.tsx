import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import * as A from "@automerge/automerge/slim";
import { ProjectedMarkdownView } from "../../../src/components/markdown/ProjectedMarkdownView";
import {
  projectMarkdownPlan,
  canRenderMarkdownProjectionInHost,
} from "../../../src/lib/markdown-projection";
import { initializeMarkdown } from "./markdown";
import { store } from "./store";
import { openPageLink } from "./links";
import { LiveEditor } from "./LiveEditor";
import { RichEditor } from "./RichEditor";
import { isRich } from "../src/richtext.mjs";
import type { Snapshot } from "../src/document.ts";
import { Comments, type CommentSelection } from "./Comments";
import "./style.css";
function Markdown({ source }: { source: string }) {
  if (!source.trim()) return null;
  const plan = projectMarkdownPlan(source);
  return plan && canRenderMarkdownProjectionInHost(plan) ? (
    <ProjectedMarkdownView plan={plan} colorTheme="cream" onLinkClick={openPageLink} />
  ) : (
    <pre>{source}</pre>
  );
}
const statusLabel = {
  connecting: "Connecting…",
  syncing: "Saving…",
  saved: "Saved",
  offline: "Offline · Changes retained",
  signed_out: "Sign in to sync",
  rejected: "Changes need attention",
};
function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [editing, setEditing] = useState<string | null | undefined>(undefined),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ id: string; request: number } | null>(null);
  const [selection, setSelection] = useState<{ blockId: string; range: CommentSelection } | null>(
    null,
  );
  useEffect(() => {
    void store.refresh();
    const guard = (event: BeforeUnloadEvent) => {
      if (store.replica && !store.replica.isSaved()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  useEffect(() => {
    setEditing(undefined);
    setActiveBlock(null);
    setSelection(null);
    setCommentTarget(null);
  }, [state.page?.page_id]);
  useEffect(() => {
    setSelection(null);
  }, [editing]);
  async function run(action: () => Promise<unknown> | unknown) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function editPage() {
    const replica = store.replica;
    if (!replica?.pageId) return;
    if (!replica.isSaved()) throw Error("Wait for current edits to save, then try again");
    // Existing Pages opt in once, in guarded batches. Do not migrate a different
    // account/Page if navigation or sign-out happens while a request is pending.
    for (;;) {
      const { content } = await store.tool<{ content: Snapshot }>("read_page", {
        page_id: replica.pageId,
      });
      if (store.replica !== replica) return;
      const blocks = content.blocks
        .filter((b) => b.kind === "markdown" && !isRich(b))
        .slice(0, 100);
      if (!blocks.length) return;
      await store.tool("edit_page", {
        page_id: replica.pageId,
        base_sequence: content.through_sequence,
        idempotency_key: crypto.randomUUID(),
        operations: blocks.map((b) => ({
          op: "enable_rich_text",
          block_id: b.id,
          expected_hash: b.hash,
        })),
      });
      if (store.replica !== replica) return;
    }
  }
  const page = state.page,
    replica = store.replica;
  const editable =
    !!replica?.doc?.page_id && !["signed_out", "rejected"].includes(state.syncStatus);
  const legacyBlocks = page?.blocks.filter((b) => b.kind === "markdown" && !isRich(b)) ?? [];
  const focusedBlock =
    page?.blocks.find((b) => b.id === activeBlock && isRich(b))?.id ??
    page?.blocks.find(isRich)?.id;
  return (
    <div className="shell">
      <aside className={navigationOpen ? "navigation-open" : ""}>
        <div className="workspace-heading">
          <a className="brand" href="/">
            nteract<span>pages</span>
          </a>
          {state.signedIn && (
            <button
              className="navigation-toggle"
              aria-expanded={navigationOpen}
              aria-controls="workspace-navigation"
              onClick={() => setNavigationOpen(!navigationOpen)}
            >
              Pages
            </button>
          )}
        </div>
        {state.signedIn && (
          <div id="workspace-navigation" className="workspace-navigation">
            <button
              className="new-page"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await store.create();
                  setNavigationOpen(false);
                })
              }
            >
              ＋ New page
            </button>
            <nav>
              {state.pages.map((p) => (
                <button
                  key={p.page_id}
                  className={p.page_id === page?.page_id ? "selected" : ""}
                  onClick={() =>
                    void run(async () => {
                      await store.open(p.page_id);
                      setNavigationOpen(false);
                    })
                  }
                >
                  {p.title || "Untitled"}
                </button>
              ))}
            </nav>
            <footer>
              <span>{state.name}</span>
              <button disabled={busy} onClick={() => void run(() => store.signOut())}>
                Sign out
              </button>
            </footer>
          </div>
        )}
      </aside>
      <main>
        {(error || state.error) && (
          <div className="notice" role="alert">
            {error || state.error}
          </div>
        )}
        {!state.ready ? (
          <p className="empty">Loading…</p>
        ) : !state.signedIn ? (
          <section className="welcome">
            <h1>A place to think together.</h1>
            <p>Write, edit, and discuss your documents.</p>
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
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(() => store.create())}
            >
              Create a page
            </button>
          </section>
        ) : (
          <>
            <header>
              <span>
                Personal <span className="slash">/</span> {page.title || "Untitled"}
              </span>
              <span className="saved" role="status">
                {statusLabel[state.syncStatus]}
              </span>
            </header>
            <article>
              <div className="page-title">
                <h1>{page.title || "Untitled"}</h1>
                <button
                  disabled={!editable}
                  onClick={() => setEditing(editing === null ? undefined : null)}
                >
                  {editing === null ? "Done" : "Rename"}
                </button>
              </div>
              {editing === null && replica && (
                <LiveEditor replica={replica} id={null} onError={setError} />
              )}
              {legacyBlocks.length > 0 && (
                <div className="page-edit-action">
                  <button disabled={!editable || busy} onClick={() => void run(editPage)}>
                    {busy ? "Opening editor…" : "Edit this page"}
                  </button>
                  {state.comments.some(
                    (t) =>
                      t.target.kind === "selection" &&
                      legacyBlocks.map((b) => b.id).includes(t.target.anchor.blockId),
                  ) && (
                    <p>
                      Existing comments stay available. Comments on selected text will lose their
                      old highlight.
                    </p>
                  )}
                </div>
              )}
              <div className="document-toolbar" ref={setToolbarHost} />
              {page.blocks.map((b) => (
                <section
                  className={`block ${b.kind === "agent_instructions" ? "instructions" : ""}`}
                  key={b.id}
                >
                  <div className="block-content">
                    {b.kind === "agent_instructions" && (
                      <div className="block-tools">
                        <span>Agent instructions</span>
                      </div>
                    )}
                    {isRich(b) && replica?.doc?.blocks?.[b.id] ? (
                      <RichEditor
                        replica={replica}
                        id={b.id}
                        editable={editable}
                        threads={state.comments}
                        commentTarget={commentTarget}
                        toolbarHost={focusedBlock === b.id ? toolbarHost : null}
                        onActivate={() => setActiveBlock(b.id)}
                        onSelection={(range) =>
                          setSelection(range ? { blockId: b.id, range } : null)
                        }
                        onError={setError}
                      />
                    ) : b.kind === "agent_instructions" && editable && replica ? (
                      <LiveEditor
                        replica={replica}
                        id={b.id}
                        onError={setError}
                        onSelection={(range) =>
                          setSelection(range ? { blockId: b.id, range } : null)
                        }
                      />
                    ) : (
                      <Markdown source={b.markdown} />
                    )}
                  </div>
                  {replica && (
                    <Comments
                      replica={replica}
                      blockId={b.id}
                      name={state.name}
                      editable={editable}
                      selection={selection?.blockId === b.id ? selection.range : null}
                      onCommented={() => setSelection(null)}
                      onReveal={
                        isRich(b)
                          ? (id) =>
                              setCommentTarget((prior) => ({
                                id,
                                request: (prior?.request ?? 0) + 1,
                              }))
                          : undefined
                      }
                      threads={state.comments.filter((t) =>
                        t.target.kind === "block"
                          ? t.target.blockId === b.id
                          : t.target.anchor.blockId === b.id,
                      )}
                    />
                  )}
                </section>
              ))}
              {replica &&
                state.comments.some(
                  (t) =>
                    !page.blocks.some(
                      (b) =>
                        b.id ===
                        (t.target.kind === "block" ? t.target.blockId : t.target.anchor.blockId),
                    ),
                ) && (
                  <Comments
                    replica={replica}
                    name={state.name}
                    editable={editable}
                    threads={state.comments.filter(
                      (t) =>
                        !page.blocks.some(
                          (b) =>
                            b.id ===
                            (t.target.kind === "block"
                              ? t.target.blockId
                              : t.target.anchor.blockId),
                        ),
                    )}
                  />
                )}
              <div className="append">
                <button
                  disabled={!editable}
                  onClick={() =>
                    void run(() => {
                      if (replica) setActiveBlock(replica.add("markdown"));
                    })
                  }
                >
                  ＋ Block
                </button>
              </div>
              {replica && replica.hasRecovery() && (
                <button onClick={() => replica.download()}>Download recovery copy</button>
              )}
              {state.syncStatus === "rejected" && (
                <button disabled={busy} onClick={() => void run(() => store.reopenSaved())}>
                  Discard pending edits and reopen saved version
                </button>
              )}
              <LegacyDraft account={state.accountKey} />
            </article>
          </>
        )}
      </main>
    </div>
  );
}
function LegacyDraft({ account }: { account: string | null }) {
  let draft: { source?: string } | null = null;
  try {
    if (account) draft = JSON.parse(sessionStorage.getItem(`pages:draft:${account}`) || "null");
  } catch {
    /* Not a usable legacy draft. */
  }
  return typeof draft?.source === "string" ? (
    <section className="recovery">
      <h2>A draft from the previous editor</h2>
      <p>Copy any text you still need into the live document.</p>
      <textarea aria-label="Previous editor draft" value={draft.source} readOnly />
    </section>
  ) : null;
}
Promise.all([
  initializeMarkdown(),
  fetch("/automerge.wasm").then(async (response) => {
    if (!response.ok) throw Error("Automerge could not be loaded");
    await A.initializeWasm(new Uint8Array(await response.arrayBuffer()));
  }),
])
  .then(() => createRoot(document.getElementById("root")!).render(<App />))
  .catch((error) => {
    document.getElementById("root")!.textContent = String(error);
  });
