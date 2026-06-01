import { describe, expect, it } from "vite-plus/test";
import {
  friendlyNotebookActorLabel,
  parseNotebookActorLabel,
  splitNotebookActorPrincipalOperator,
} from "../actor-labels";

describe("notebook actor labels", () => {
  it("splits durable principal/operator labels without changing either side", () => {
    expect(
      splitNotebookActorPrincipalOperator("user:dev:kyle%40example.com/agent:codex:s1"),
    ).toEqual(["user:dev:kyle%40example.com", "agent:codex:s1"]);
  });

  it("projects delegated agents with a friendly principal label", () => {
    expect(parseNotebookActorLabel("user:dev:kyle%40example.com/agent:codex:s1")).toEqual({
      kind: "agent",
      label: "Codex",
      onBehalfOf: "kyle@example.com",
    });
  });

  it("projects runtime and system operators independently from document access", () => {
    expect(parseNotebookActorLabel("user:anaconda:alice/runtime:jupyterhub")).toEqual({
      kind: "runtime",
      label: "JupyterHub",
      onBehalfOf: "Alice",
    });
    expect(parseNotebookActorLabel("system/schema:notebook:v5")).toEqual({
      kind: "system",
      label: "Schema",
      onBehalfOf: null,
    });
  });

  it("turns raw principals into human-scale labels for presence fallbacks", () => {
    expect(friendlyNotebookActorLabel("anonymous:viewer:session-a/browser:tab")).toBe("Anonymous");
    expect(
      friendlyNotebookActorLabel("user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab"),
    ).toBe("Anaconda user");
    expect(friendlyNotebookActorLabel("user:anaconda:alice/browser:tab")).toBe("Alice");
  });
});
