// ---------------------------------------------------------------------------
// In-comment AI assistant ("@ana").
//
// Typing `@ana <question>` in a comment or reply summons the assistant. It does
// NOT open a separate chat surface — the answer is posted back as a reply in
// the same comment thread, authored by an agent actor so it renders with the
// Bot avatar (see notebook-actor-display / reply_comment_thread_as_agent).
//
// This module owns the pure edges of that flow:
//   - detecting the trigger in a submitted comment body
//   - assembling the LLM prompt from the thread's anchored context + history
//   - streaming the completion (buffered) to a final answer string
//
// The daemon `/assistant/chat` proxy owns auth + the upstream gateway; we speak
// OpenAI chat-completions to it via `streamAssistantChat`. See
// assistant-chat-client.ts.
// ---------------------------------------------------------------------------

import { getCellById } from "@/components/notebook/state/cell-store";
import type {
  CommentAnchor,
  CommentMessageSnapshot,
  CommentThreadSnapshot,
} from "@/components/notebook/comment-types";
import { type AssistantChatMessage, streamAssistantChat } from "./assistant-chat-client";
import { logger } from "./logger";

/** Display name the assistant answers as. */
export const ASSISTANT_COMMENT_NAME = "ana";

/**
 * Matches an `@ana` mention as a standalone token (word boundary before, and
 * whitespace/end/punctuation after) so it doesn't fire on `@anaconda` or an
 * email address. Case-insensitive.
 */
const TRIGGER_RE = /(^|[\s(])@ana(?=$|[\s.,!?:;)]) ?/i;

/** True when a submitted comment body should summon the assistant. */
export function mentionsAssistant(body: string): boolean {
  return TRIGGER_RE.test(body);
}

/**
 * Strip the `@ana` mention from a body, returning the remaining question text.
 * If the mention was the whole message, returns an empty string.
 */
export function stripAssistantMention(body: string): string {
  return body.replace(TRIGGER_RE, "$1").trim();
}

/**
 * Derive an agent actor label from the local user's actor so the assistant's
 * reply renders as an agent "on behalf of" the user.
 *
 * The frontend treats an actor label with an `agent:` operator segment as an
 * agent (see operatorFromLabel / actorKindFromProjection). We append one to the
 * local principal, dropping any existing operator segment (e.g. `desktop:xyz`)
 * the local actor carries.
 */
export function assistantActorLabel(localActor: string | null | undefined): string {
  const principal = (localActor ?? "").split("/")[0] || "local";
  return `${principal}/agent:${ASSISTANT_COMMENT_NAME}`;
}

const SYSTEM_PROMPT = [
  "You are ana, an AI assistant embedded in an nteract notebook's comment threads.",
  "A user has mentioned you (@ana) in a comment. Answer their question concisely and helpfully.",
  "You are given the notebook context the comment is anchored to (a cell's source, an output, or the whole notebook) plus the conversation so far.",
  "Reply in GitHub-flavored Markdown. Use fenced code blocks for code. Be direct — this is a comment reply, not an essay.",
  "You cannot yet edit cells or run code; if asked to, explain what change you would make and show the code, but note that applying it is a future capability.",
].join(" ");

/** Human-readable label for an anchor kind, used in the context preamble. */
function anchorContext(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "cell":
    case "source_range":
    case "output": {
      const cell = getCellById(anchor.cell_id);
      if (!cell) return `The comment is anchored to cell ${anchor.cell_id} (source unavailable).`;
      const lang =
        cell.cell_type === "code" ? "python" : cell.cell_type === "markdown" ? "markdown" : "";
      const kindLabel =
        anchor.kind === "output"
          ? "the OUTPUT of this cell"
          : anchor.kind === "source_range"
            ? "a text selection in this cell"
            : "this cell";
      const header = `The comment is anchored to ${kindLabel} (${cell.cell_type} cell ${anchor.cell_id}). Cell source:`;
      return `${header}\n\n\`\`\`${lang}\n${cell.source}\n\`\`\``;
    }
    case "cell_range": {
      const start = getCellById(anchor.start_cell_id);
      const end = getCellById(anchor.end_cell_id);
      const parts = [start, end]
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => `\`\`\`\n${c.source}\n\`\`\``)
        .join("\n\n");
      return `The comment is anchored to a range of cells. Sources:\n\n${parts}`;
    }
    case "notebook":
      return "The comment is a notebook-level comment (not anchored to a specific cell).";
  }
}

/**
 * Build the OpenAI chat messages for an assistant reply from the thread's
 * anchored context and its prior messages. `pendingUserBody` is the just-
 * submitted comment that summoned the assistant (it may not be in
 * `priorMessages` yet, depending on projection timing).
 */
export function buildAssistantMessages({
  anchor,
  priorMessages,
  pendingUserBody,
  assistantActorLabelValue,
}: {
  anchor: CommentAnchor;
  priorMessages: CommentMessageSnapshot[];
  pendingUserBody: string;
  assistantActorLabelValue: string;
}): AssistantChatMessage[] {
  const messages: AssistantChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: anchorContext(anchor) },
  ];

  // Replay the thread so the assistant sees the conversation. Its own prior
  // replies (authored by the agent actor) map to `assistant`; everything else
  // is a `user` turn. Skip the pending body if it already landed in the
  // projection to avoid duplicating it (comparison is mention-stripped on both
  // sides so the trigger token doesn't defeat the match).
  const pendingStripped = stripAssistantMention(pendingUserBody);
  let sawPending = false;
  for (const message of priorMessages) {
    const isAssistant = message.created_by_actor_label === assistantActorLabelValue;
    const content = isAssistant ? message.body : stripAssistantMention(message.body);
    if (!content.trim()) continue;
    if (!isAssistant && content === pendingStripped) sawPending = true;
    messages.push({ role: isAssistant ? "assistant" : "user", content });
  }
  if (!sawPending && pendingStripped) {
    messages.push({ role: "user", content: pendingStripped });
  }

  return messages;
}

/**
 * Stream an assistant completion and resolve with the full answer text.
 *
 * Tokens are buffered rather than written incrementally: a comment body is an
 * Automerge Text object, and streaming token-by-token would flood sync with one
 * change per token. We post the final answer as a single reply instead.
 */
export async function requestAssistantAnswer({
  messages,
  signal,
  onToken,
}: {
  messages: AssistantChatMessage[];
  signal?: AbortSignal;
  onToken?: (partial: string) => void;
}): Promise<string> {
  let answer = "";
  await streamAssistantChat({
    messages,
    signal,
    onToken: (token) => {
      answer += token;
      onToken?.(answer);
    },
  });
  const trimmed = answer.trim();
  if (!trimmed) {
    logger.warn("[assistant-comments] assistant returned an empty answer");
    throw new Error("The assistant returned an empty response.");
  }
  return trimmed;
}

/** Convenience wrapper used by callers that only need the final text. */
export async function generateAssistantReply(params: {
  anchor: CommentAnchor;
  thread: CommentThreadSnapshot;
  pendingUserBody: string;
  localActor: string | null | undefined;
  signal?: AbortSignal;
}): Promise<string> {
  const assistantActorLabelValue = assistantActorLabel(params.localActor);
  const messages = buildAssistantMessages({
    anchor: params.anchor,
    priorMessages: params.thread.messages,
    pendingUserBody: params.pendingUserBody,
    assistantActorLabelValue,
  });
  return requestAssistantAnswer({ messages, signal: params.signal });
}
