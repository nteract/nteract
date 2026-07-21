import { ArrowUp, Check, Copy, RefreshCw, Sparkles, Square, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Streamdown, type Components } from "streamdown";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockFilename,
} from "@/components/ui/code-block";
import type { BundledLanguage } from "shiki";
import { openUrl } from "../lib/open-url";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 py-0.5" aria-label="Typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 rounded-full bg-foreground/40"
          style={{
            animation: `assistant-dot 1.4s cubic-bezier(0.4,0,0.6,1) ${i * 0.18}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes assistant-dot {
          0%, 100% { opacity: 0.2; transform: scale(0.75); }
          50% { opacity: 0.85; transform: scale(1); }
        }
      `}</style>
    </span>
  );
}

/**
 * Assistant side panel — a standalone chat against the daemon's
 * `/assistant/chat` proxy. Does not read or write notebook state.
 */

const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 384;

export function AssistantPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragStartX = useRef<number | null>(null);
  const dragStartWidth = useRef<number>(DEFAULT_WIDTH);

  const markdownComponents: Components = {
    a: ({ href, children }) => (
      <a
        role="link"
        tabIndex={0}
        className="cursor-pointer"
        onClick={(e) => {
          e.preventDefault();
          if (href) setPendingUrl(href);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (href) setPendingUrl(href);
          }
        }}
      >
        {children}
      </a>
    ),
    img: ({ src, alt, ...props }) => <img {...props} src={src} alt={alt ?? ""} />,
    pre: ({ node, children: _children, ...props }) => {
      // Extract language and code from the child <code> element
      const codeEl = (
        node as {
          children?: Array<{
            tagName?: string;
            properties?: Record<string, unknown>;
            children?: Array<{ value?: string }>;
          }>;
        }
      )?.children?.find((c) => c.tagName === "code");
      const className = String(codeEl?.properties?.className ?? "");
      const lang = (className.match(/language-(\S+)/)?.[1] ?? "text") as BundledLanguage;
      const code = codeEl?.children?.map((c) => c.value ?? "").join("") ?? "";

      return (
        <CodeBlock code={code} language={lang} className="my-4 not-prose" {...(props as object)}>
          <CodeBlockHeader>
            <CodeBlockTitle>
              <CodeBlockFilename>{lang}</CodeBlockFilename>
            </CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      );
    },
  };

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragStartX.current = event.clientX;
      dragStartWidth.current = width;
      (event.target as HTMLDivElement).setPointerCapture(event.pointerId);
    },
    [width],
  );

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartX.current === null) return;
    const delta = dragStartX.current - event.clientX;
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartWidth.current + delta)));
  }, []);

  const handleResizePointerUp = useCallback(() => {
    dragStartX.current = null;
  }, []);

  // Keep the transcript pinned to the bottom as tokens stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Auto-grow the textarea to fit its content.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const streamResponse = useCallback(
    async (history: AssistantChatMessage[], assistantId: string) => {
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
                  content: aborted
                    ? m.content || "(stopped)"
                    : m.content ||
                      `Error: ${error instanceof Error ? error.message : String(error)}`,
                  isError: !aborted && m.content.length === 0,
                }
              : m,
          ),
        );
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMessage: ChatMessage = { id: nextMessageId(), role: "user", content: text };
    const assistantId = nextMessageId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      isStreaming: true,
    };

    // Build the OpenAI-style history including this turn.
    const history: AssistantChatMessage[] = [
      ...messages.filter((m) => !m.isError).map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: text },
    ];

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    await streamResponse(history, assistantId);
  }, [input, isStreaming, messages, streamResponse]);

  const retry = useCallback(
    async (messageId: string) => {
      if (isStreaming) return;
      // Find the assistant message to retry and replace it with a fresh one.
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        return prev.map((m, i) =>
          i === idx ? { ...m, content: "", isStreaming: true, isError: false } : m,
        );
      });
      // Snapshot history up to (but not including) the target assistant message.
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        const history = prev
          .slice(0, idx)
          .filter((m) => !m.isError)
          .map((m) => ({ role: m.role, content: m.content }));
        void streamResponse(history as AssistantChatMessage[], messageId);
        return prev;
      });
    },
    [isStreaming, streamResponse],
  );

  const copyMessage = useCallback((messageId: string, content: string) => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopiedId(messageId);
      setTimeout(() => setCopiedId((id) => (id === messageId ? null : id)), 2000);
    });
  }, []);

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
    <>
      <Dialog
        open={pendingUrl !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUrl(null);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Open external link?</DialogTitle>
            <DialogDescription className="break-all">{pendingUrl}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setPendingUrl(null)}
              className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (pendingUrl) void openUrl(pendingUrl);
                setPendingUrl(null);
              }}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            >
              Open
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <aside
        data-testid="assistant-panel"
        className="relative flex h-full shrink-0 flex-col border-l bg-background"
        style={{ width }}
        aria-label="Assistant"
      >
        {/* Resize handle */}
        <div
          className="absolute inset-y-0 left-0 w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
        />
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
                  "group flex flex-col gap-1",
                  message.role === "user" ? "items-end" : "items-start",
                )}
              >
                <div
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm",
                    message.role === "user"
                      ? "max-w-[85%] bg-primary text-primary-foreground whitespace-pre-wrap break-words"
                      : "w-[calc(100%-2rem)] bg-muted text-foreground",
                    message.isError && "bg-destructive/10 text-destructive",
                  )}
                >
                  {message.role === "assistant" ? (
                    message.content.length === 0 && message.isStreaming ? (
                      <TypingIndicator />
                    ) : (
                      <Streamdown
                        mode={message.isStreaming ? "streaming" : "static"}
                        className="prose prose-sm dark:prose-invert max-w-none [&_ul]:pl-5 [&_ol]:pl-5"
                        components={markdownComponents}
                        linkSafety={{ enabled: false }}
                        allowedTags={{ img: ["src", "alt", "title", "width", "height"] }}
                      >
                        {message.content}
                      </Streamdown>
                    )
                  ) : (
                    <>{message.content}</>
                  )}
                </div>
                {message.role === "assistant" && !message.isStreaming && (
                  <div className="flex gap-1 px-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => copyMessage(message.id, message.content)}
                      title="Copy as markdown"
                      aria-label="Copy as markdown"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {copiedId === message.id ? (
                        <Check className="size-3" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                      {copiedId === message.id ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void retry(message.id)}
                      disabled={isStreaming}
                      title="Retry"
                      aria-label="Retry"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      <RefreshCw className="size-3" />
                      Retry
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleSubmit} className="shrink-0 border-t p-3">
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="Message the assistant…"
              data-testid="assistant-input"
              className="block w-full resize-none overflow-hidden rounded-2xl border bg-background pl-3 pr-10 py-2 text-sm leading-5 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            />
            <button
              type={isStreaming ? "button" : "submit"}
              onClick={isStreaming ? stop : undefined}
              disabled={!isStreaming && input.trim().length === 0}
              title={isStreaming ? "Stop" : "Send (⌘↵)"}
              aria-label={isStreaming ? "Stop" : "Send"}
              data-testid={isStreaming ? "assistant-stop" : "assistant-send"}
              className={cn(
                "absolute bottom-1 right-1 inline-flex size-7 items-center justify-center rounded-full transition-opacity",
                isStreaming ? "bg-muted text-foreground" : "bg-primary text-primary-foreground",
                !isStreaming && input.trim().length === 0 && "cursor-not-allowed opacity-40",
              )}
            >
              {isStreaming ? (
                <Square className="size-3" fill="currentColor" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
