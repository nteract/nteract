import { useState } from "react";
import type { PageReplica } from "./replica.ts";
import type { ProjectedThread } from "../src/comments.ts";
export interface CommentSelection {
  text: string;
  occurrence: number;
}
function Composer({ label, onSubmit }: { label: string; onSubmit: (body: string) => void }) {
  const [body, setBody] = useState(""),
    [error, setError] = useState("");
  return (
    <form
      className="comment-composer"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          onSubmit(body);
          setBody("");
          setError("");
        } catch (e) {
          setError(String(e instanceof Error ? e.message : e));
        }
      }}
    >
      <textarea
        aria-label={label}
        placeholder={label}
        value={body}
        maxLength={16000}
        onChange={(event) => setBody(event.target.value)}
        required
      />
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={!body.trim()}>
        {label === "Reply" ? "Reply" : "Post"}
      </button>
    </form>
  );
}
export function Comments({
  replica,
  threads,
  blockId,
  selection,
  editable,
  name,
  onCommented,
}: {
  replica: PageReplica;
  threads: ProjectedThread[];
  blockId?: string;
  selection?: CommentSelection | null;
  editable: boolean;
  name: string;
  onCommented?: () => void;
}) {
  const [expanded, setExpanded] = useState(!blockId),
    [showResolved, setShowResolved] = useState(false),
    [error, setError] = useState("");
  const actor = replica.commentAuthorId();
  const authorName = (id: string, fallback: string) => (id === actor ? name : fallback);
  function change(input: Record<string, unknown>) {
    try {
      replica.comment(input);
      setError("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  const open = threads.filter((t) => t.state === "open").length;
  return (
    <section className="comments" aria-label={blockId ? "Block comments" : "Detached comments"}>
      {blockId ? (
        <button
          className="comments-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={
            selection
              ? "Comment on selection"
              : open
                ? `${open} open comment${open === 1 ? "" : "s"}`
                : "Comments"
          }
        >
          {open ? `Comments · ${open}` : selection ? "Comment on selection" : "Comment"}
        </button>
      ) : (
        <h2>Comments on removed content</h2>
      )}
      {expanded && (
        <div className="comment-discussion">
          {threads.some((t) => t.state === "resolved") && (
            <label className="comment-filter">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
              />{" "}
              Show resolved
            </label>
          )}
          {error && <p role="alert">{error}</p>}
          {threads
            .filter((t) => showResolved || t.state === "open")
            .map((t) => (
              <section className="comment-thread" key={t.id} aria-label="Comment thread">
                <div className="comment-thread-heading">
                  <span>
                    {t.state === "resolved" ? "Resolved" : ""}
                    {t.detached ? `${t.state === "resolved" ? " · " : ""}Passage removed` : ""}
                  </span>
                  {editable && (
                    <button
                      onClick={() =>
                        change({
                          action: t.state === "resolved" ? "reopen" : "resolve",
                          thread_id: t.id,
                        })
                      }
                    >
                      {t.state === "resolved" ? "Reopen" : "Resolve"}
                    </button>
                  )}
                </div>
                {t.selectionContext?.status === "attached" && (
                  <blockquote>
                    {t.selectionContext.text}
                    {t.selectionContext.truncated ? "…" : ""}
                  </blockquote>
                )}
                {t.messages.map((m) => (
                  <div className="comment-message" key={m.id}>
                    <div className="comment-byline">
                      <strong>{authorName(m.author.id, m.author.displayName)}</strong>
                      <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString()}</time>
                      {m.editedAt && <small>edited</small>}
                    </div>
                    <p>{m.deletedAt ? <em>Message deleted</em> : m.body}</p>
                  </div>
                ))}
                {editable && t.state === "open" && (
                  <Composer
                    label="Reply"
                    onSubmit={(body) => replica.comment({ action: "reply", thread_id: t.id, body })}
                  />
                )}
              </section>
            ))}
          {editable && blockId && (
            <div className="new-comment">
              {selection && <blockquote>{selection.text.replaceAll("\ufffc", "\n")}</blockquote>}
              <Composer
                label={selection ? "Comment on selection" : "Add a comment"}
                onSubmit={(body) => {
                  replica.comment({
                    action: "add",
                    block_id: blockId,
                    body,
                    ...(selection
                      ? { selected_text: selection.text, occurrence: selection.occurrence }
                      : {}),
                  });
                  onCommented?.();
                }}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
