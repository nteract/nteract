import { describe, expect, it, vi } from "vite-plus/test";
import type { CommentMessageSnapshot } from "@/components/notebook/comment-types";

// buildAssistantMessages reads cell source from the cell store; stub it so the
// prompt-assembly tests don't need a live WASM notebook.
vi.mock("@/components/notebook/state/cell-store", () => ({
  getCellById: (id: string) =>
    id === "cell-a"
      ? { cell_type: "code", id, source: "print(sum(xs))", execution_count: null, outputs: [], metadata: {} }
      : undefined,
}));

const {
  mentionsAssistant,
  stripAssistantMention,
  assistantActorLabel,
  buildAssistantMessages,
  ASSISTANT_COMMENT_NAME,
} = await import("../assistant-comments");

describe("mentionsAssistant", () => {
  it("fires on a standalone @ana token", () => {
    expect(mentionsAssistant("@ana what does this do?")).toBe(true);
    expect(mentionsAssistant("hey @ana, help")).toBe(true);
    expect(mentionsAssistant("(@ana)")).toBe(true);
    expect(mentionsAssistant("explain this @ana")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(mentionsAssistant("@Ana please")).toBe(true);
  });

  it("does not fire on @anaconda or emails", () => {
    expect(mentionsAssistant("install @anaconda")).toBe(false);
    expect(mentionsAssistant("email ana@anaconda.com")).toBe(false);
    expect(mentionsAssistant("no mention here")).toBe(false);
  });
});

describe("stripAssistantMention", () => {
  it("removes the mention and trims", () => {
    expect(stripAssistantMention("@ana what does this do?")).toBe("what does this do?");
    expect(stripAssistantMention("hey @ana help")).toBe("hey help");
  });

  it("returns empty when the mention is the whole message", () => {
    expect(stripAssistantMention("@ana")).toBe("");
  });
});

describe("assistantActorLabel", () => {
  it("appends an agent operator to the local principal", () => {
    expect(assistantActorLabel("user:anaconda:alice/desktop:win1")).toBe(
      `user:anaconda:alice/agent:${ASSISTANT_COMMENT_NAME}`,
    );
  });

  it("handles a bare principal and a null actor", () => {
    expect(assistantActorLabel("desktop:abc")).toBe(`desktop:abc/agent:${ASSISTANT_COMMENT_NAME}`);
    expect(assistantActorLabel(null)).toBe(`local/agent:${ASSISTANT_COMMENT_NAME}`);
  });
});

describe("buildAssistantMessages", () => {
  const agentActor = "user:alice/agent:ana";

  it("includes system prompt, cell context, and the pending question", () => {
    const messages = buildAssistantMessages({
      anchor: { kind: "cell", cell_id: "cell-a" },
      priorMessages: [],
      pendingUserBody: "@ana what does this do?",
      assistantActorLabelValue: agentActor,
    });
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("system");
    expect(messages[1].content).toContain("print(sum(xs))");
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    // The mention is stripped before being sent to the model.
    expect(last.content).toBe("what does this do?");
  });

  it("maps prior agent messages to assistant turns and dedupes the pending body", () => {
    const prior: CommentMessageSnapshot[] = [
      {
        id: "m1",
        position: "80",
        body: "@ana explain",
        created_at: "",
        created_by_actor_label: "user:alice",
      },
      {
        id: "m2",
        position: "81",
        body: "It sums xs.",
        created_at: "",
        created_by_actor_label: agentActor,
      },
      {
        id: "m3",
        position: "82",
        body: "@ana and now?",
        created_at: "",
        created_by_actor_label: "user:alice",
      },
    ];
    const messages = buildAssistantMessages({
      anchor: { kind: "notebook" },
      priorMessages: prior,
      pendingUserBody: "@ana and now?",
      assistantActorLabelValue: agentActor,
    });
    const convo = messages.filter((m) => m.role !== "system");
    expect(convo).toEqual([
      { role: "user", content: "explain" },
      { role: "assistant", content: "It sums xs." },
      { role: "user", content: "and now?" },
    ]);
    // Pending body already present in prior messages — not appended twice.
    expect(convo.filter((m) => m.content === "and now?")).toHaveLength(1);
  });
});
