"use client";

import { useEffect, useRef, useState } from "react";
import { NotebookCommentsPanel, type CommentAuthor } from "@/components/notebook";
import type { CommentsProjection } from "@/components/notebook/comment-types";
import { cn } from "@/lib/utils";

// Fixture actors. The panel itself is presentational. Attribution (name,
// color, AI-on-behalf) is resolved by the host through resolveCommentAuthor,
// so the design-system view declares the contract with a small fixture map.
const ADA = "local:ada/desktop:1";
const CLAUDE = "local:ada/agent:claude-code:1";
const ADA_COLOR = "#16a34a";
const CLAUDE_COLOR = "#7c3aed";

function resolveCommentAuthor(actorLabel: string): CommentAuthor {
  if (actorLabel === CLAUDE) {
    return {
      displayName: "Claude Code",
      color: CLAUDE_COLOR,
      imageUrl: null,
      isAgent: true,
      onBehalfOf: "Ada",
      onBehalfOfColor: ADA_COLOR,
    };
  }
  return { displayName: "Ada", color: ADA_COLOR, imageUrl: null };
}

function resolveSourceLanguage(): string {
  return "python";
}

const INITIAL: CommentsProjection = {
  comments_doc_id: "comments:elements-fixture",
  threads: [
    {
      id: "thread-diff",
      anchor: {
        kind: "source_range",
        cell_id: "cell-1",
        start_line: 9,
        start_column: 5,
        end_line: 9,
        end_column: 18,
        exact_quote: "sp.diff(f, x)",
        prefix_quote: "df = ",
      },
      position: "10",
      status: "open",
      badge_cell_ids: ["cell-1"],
      created_at: "2026-06-18T15:00:00Z",
      created_by_actor_label: ADA,
      messages: [
        {
          id: "m1",
          position: "10",
          body: "This derivative could read more clearly. Maybe name the result?",
          created_at: "2026-06-18T15:00:00Z",
          created_by_actor_label: ADA,
        },
        {
          id: "m2",
          position: "20",
          body: "Agreed. Want me to pull it into a `derivative` variable and add a docstring?",
          created_at: "2026-06-18T15:02:00Z",
          created_by_actor_label: CLAUDE,
        },
      ],
    },
    {
      id: "thread-doc",
      anchor: { kind: "notebook" },
      position: "20",
      status: "open",
      badge_cell_ids: [],
      created_at: "2026-06-18T15:20:00Z",
      created_by_actor_label: ADA,
      messages: [
        {
          id: "m-doc",
          position: "10",
          body: "Let's keep this notebook as the worked example for the docs.",
          created_at: "2026-06-18T15:20:00Z",
          created_by_actor_label: ADA,
        },
      ],
    },
    {
      id: "thread-import",
      anchor: {
        kind: "source_range",
        cell_id: "cell-1",
        start_line: 2,
        start_column: 0,
        end_line: 2,
        end_column: 18,
        exact_quote: "import sympy as sp",
      },
      position: "5",
      status: "resolved",
      badge_cell_ids: ["cell-1"],
      created_at: "2026-06-18T14:00:00Z",
      created_by_actor_label: ADA,
      resolved_at: "2026-06-18T14:10:00Z",
      resolved_by_actor_label: CLAUDE,
      messages: [
        {
          id: "m3",
          position: "10",
          body: "Should we pin the SymPy version for reproducibility?",
          created_at: "2026-06-18T14:00:00Z",
          created_by_actor_label: ADA,
        },
      ],
    },
  ],
};

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function CommentSurfacesExample() {
  const [projection, setProjection] = useState<CommentsProjection>(INITIAL);
  const nowRef = useRef("2026-06-18T15:30:00Z");

  // Quote syntax highlighting is theme-dependent, so the server (light) and the
  // hydrated client (the reader's theme) disagree on colors. Gate on mount so
  // SSR and the first client paint render the same placeholder, then upgrade.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const appendMessage = (threadId: string, body: string) =>
    setProjection((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              status: "open",
              resolved_at: null,
              resolved_by_actor_label: null,
              messages: [
                ...thread.messages,
                {
                  id: nextId("m"),
                  position: nextId("p"),
                  body,
                  created_at: nowRef.current,
                  created_by_actor_label: ADA,
                },
              ],
            }
          : thread,
      ),
    }));

  const setStatus = (threadId: string, status: "open" | "resolved") =>
    setProjection((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === threadId
          ? status === "resolved"
            ? {
                ...thread,
                status,
                resolved_at: nowRef.current,
                resolved_by_actor_label: ADA,
              }
            : {
                ...thread,
                status,
                resolved_at: null,
                resolved_by_actor_label: null,
              }
          : thread,
      ),
    }));

  return (
    <div className={cn("not-prose my-6 flex justify-center")}>
      <div className="w-[340px] rounded-xl border bg-background p-3.5 shadow-sm">
        {!mounted ? (
          <div className="h-[420px]" aria-hidden />
        ) : (
          <NotebookCommentsPanel
            projection={projection}
            resolveCommentAuthor={resolveCommentAuthor}
            resolveSourceLanguage={resolveSourceLanguage}
            onCreateThread={(body) =>
              setProjection((current) => ({
                ...current,
                threads: [
                  ...current.threads,
                  {
                    id: nextId("thread"),
                    anchor: { kind: "notebook" },
                    position: nextId("p"),
                    status: "open",
                    badge_cell_ids: [],
                    created_at: nowRef.current,
                    created_by_actor_label: ADA,
                    messages: [
                      {
                        id: nextId("m"),
                        position: nextId("p"),
                        body,
                        created_at: nowRef.current,
                        created_by_actor_label: ADA,
                      },
                    ],
                  },
                ],
              }))
            }
            onReplyThread={appendMessage}
            onResolveThread={(id) => setStatus(id, "resolved")}
            onReopenThread={(id) => setStatus(id, "open")}
          />
        )}
      </div>
    </div>
  );
}
