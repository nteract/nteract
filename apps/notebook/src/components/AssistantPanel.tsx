import { Send, Sparkles, Square, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { streamAssistantChat, type AssistantChatMessage } from "../lib/assistant-chat-client";
import { logger } from "../lib/logger";
import { setAssistantPanelOpen } from "../lib/assistant-panel-state";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  isError?: boolean;
}

let messageCounter = 0;
function nextMessageId(): string {
  messageCounter += 1;
  return `msg-${messageCounter}`;
}

/**
 * Assistant side panel — a standalone chat against the daemon's
 * `/assistant/chat` proxy. Does not read or write notebook state.
 */
export function AssistantPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the transcript pinned to the bottom as tokens stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMessage: ChatMessage = {
      id: nextMessageId(),
      role: "user",
      content: text,
    };
    const assistantId = nextMessageId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      isStreaming: true,
    };

    // Build the OpenAI-style history from what we're about to render, so the
    // request reflects the full conversation including this turn.
    const history: AssistantChatMessage[] = [
      ...messages.filter((m) => !m.isError).map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: text },
    ];

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const appendToken = (token: string) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + token } : m)),
      );
    };

    try {
      await streamAssistantChat({
        messages: history,
        onToken: appendToken,
        signal: controller.signal,
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m)),
      );
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (!aborted) logger.error("[assistant-chat] stream failed:", error);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                isStreaming: false,
                // Preserve partial content on user-initiated stop; surface an
                // error message only on a genuine failure.
                content: aborted
                  ? m.content || "(stopped)"
                  : m.content || `Error: ${error instanceof Error ? error.message : String(error)}`,
                isError: !aborted && m.content.length === 0,
              }
            : m,
        ),
      );
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  }, [input, isStreaming, messages]);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void send();
    },
    [send],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    },
    [send],
  );

  return (
    <aside
      data-testid="assistant-panel"
      className="flex h-full w-[clamp(20rem,26vw,24rem)] shrink-0 flex-col border-l bg-background"
      aria-label="Assistant"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Sparkles className="size-4 text-violet-500" />
        <span className="text-sm font-medium">Assistant</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setAssistantPanelOpen(false)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Close assistant"
          aria-label="Close assistant"
          data-testid="assistant-close"
        >
          <X className="size-4" />
        </button>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
        data-testid="assistant-messages"
      >
        {messages.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            Ask the assistant anything.
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              data-testid={`assistant-message-${message.role}`}
              data-role={message.role}
              className={cn(
                "flex flex-col gap-1",
                message.role === "user" ? "items-end" : "items-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm",
                  message.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                  message.isError && "bg-destructive/10 text-destructive",
                )}
              >
                {message.content}
                {message.isStreaming && message.content.length === 0 ? (
                  <span className="text-muted-foreground">…</span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex shrink-0 items-end gap-2 border-t p-3">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="Message the assistant…"
          data-testid="assistant-input"
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {isStreaming ? (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={stop}
            title="Stop"
            aria-label="Stop"
            data-testid="assistant-stop"
          >
            <Square className="size-4" fill="currentColor" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={input.trim().length === 0}
            title="Send"
            aria-label="Send"
            data-testid="assistant-send"
          >
            <Send className="size-4" />
          </Button>
        )}
      </form>
    </aside>
  );
}
