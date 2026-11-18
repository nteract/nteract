// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
  CURSOR_COLORS,
  colorForActorIdentity,
  contrastColorForActorIdentity,
  identityColorKey,
  peerColor,
  readableForegroundForColor,
} from "../src/index";

describe("peerColor", () => {
  it("picks a stable palette color for a key", () => {
    expect(CURSOR_COLORS).toContain(peerColor("peer-a"));
    expect(peerColor("peer-a")).toBe(peerColor("peer-a"));
    expect(peerColor("")).toBe(CURSOR_COLORS[0]);
  });
});

describe("identityColorKey", () => {
  it("drops the per-connection instance from human operators", () => {
    expect(identityColorKey("user:dev:ada/browser:tab-a")).toBe("user:dev:ada/browser");
    expect(identityColorKey("user:dev:ada/desktop:app")).toBe("user:dev:ada/desktop");
  });

  it("keeps the agent, runtime and system name", () => {
    expect(identityColorKey("user:dev:ada/agent:codex:s1")).toBe("user:dev:ada/agent:codex");
    expect(identityColorKey("user:dev:ada/runtime:kernel:k1")).toBe("user:dev:ada/runtime:kernel");
    expect(identityColorKey("system/invite-resolution")).toBe("system/invite-resolution");
  });

  it("returns a label without an operator unchanged", () => {
    expect(identityColorKey("user:dev:ada")).toBe("user:dev:ada");
  });
});

describe("colorForActorIdentity", () => {
  it("gives every session of one identity the same color", () => {
    expect(colorForActorIdentity("user:dev:ada/browser:tab-a")).toBe(
      colorForActorIdentity("user:dev:ada/browser:tab-b"),
    );
    expect(colorForActorIdentity("user:dev:ada/browser:tab-a")).toBe(
      peerColor("user:dev:ada/browser"),
    );
  });
});

describe("readableForegroundForColor", () => {
  it("chooses the higher-contrast foreground", () => {
    expect(readableForegroundForColor("#ffffff")).toBe("#111827");
    expect(readableForegroundForColor("#fff")).toBe("#111827");
    expect(readableForegroundForColor("#000000")).toBe("#ffffff");
    expect(readableForegroundForColor("#2563eb")).toBe("#ffffff");
    expect(readableForegroundForColor("#d97706")).toBe("#111827");
  });

  it("falls back to white for a color it cannot parse", () => {
    expect(readableForegroundForColor("blue")).toBe("#ffffff");
  });
});

describe("contrastColorForActorIdentity", () => {
  it("pairs with the identity color", () => {
    const actor = "user:dev:ada/agent:codex:s1";
    expect(contrastColorForActorIdentity(actor)).toBe(
      readableForegroundForColor(colorForActorIdentity(actor)),
    );
  });
});
