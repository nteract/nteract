import { getBlobPort } from "./blob-port";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Assistant chat client.
//
// A deliberately small client for the assistant side panel. It POSTs an
// OpenAI-style chat completion to the daemon's `/assistant/chat` proxy (served
// on the blob-server origin) and streams the SSE response back token by token.
//
// The daemon proxy owns auth (via the `anaconda` CLI) and the real upstream
// URL/headers; this client just speaks OpenAI chat-completions to it. It does
// NOT touch notebook/Automerge state — the panel is a standalone chat.
// ---------------------------------------------------------------------------

export interface AssistantChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatOptions {
  messages: AssistantChatMessage[];
  /** Called for each streamed content token as it arrives. */
  onToken: (token: string) => void;
  /** Abort signal so the panel can cancel an in-flight request. */
  signal?: AbortSignal;
}

/** Thrown when the daemon blob port isn't resolved yet (no daemon connection). */
export class AssistantChatUnavailableError extends Error {
  constructor() {
    super("Assistant is unavailable — no daemon connection yet.");
    this.name = "AssistantChatUnavailableError";
  }
}

function assistantChatUrl(): string {
  const port = getBlobPort();
  if (port === null) throw new AssistantChatUnavailableError();
  return `http://127.0.0.1:${port}/assistant/chat`;
}

/**
 * Stream a chat completion. Resolves once the stream completes; rejects on
 * transport/HTTP errors (or the caller aborting via `signal`).
 */
export async function streamAssistantChat({
  messages,
  onToken,
  signal,
}: StreamChatOptions): Promise<void> {
  const url = assistantChatUrl();
  logger.debug("[assistant-chat] POST", url);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, stream: true }),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Assistant request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Parse the OpenAI SSE stream: events are separated by a blank line, each
  // event's payload lives on `data:` lines. `data: [DONE]` ends the stream.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      handleEvent(rawEvent, onToken);
    }
  }
  // Flush any trailing event without a terminating blank line.
  if (buffer.trim().length > 0) handleEvent(buffer, onToken);
}

function handleEvent(rawEvent: string, onToken: (token: string) => void): void {
  for (const line of rawEvent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Non-JSON keep-alive or partial chunk — ignore.
      continue;
    }

    const token = (parsed as ChatCompletionChunk)?.choices?.[0]?.delta?.content;
    if (typeof token === "string" && token.length > 0) onToken(token);
  }
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}
