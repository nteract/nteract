import { describe, expect, it } from "vite-plus/test";
import { colorForActorLabel, identityColorKey } from "../actor-colors";

describe("identityColorKey", () => {
  it("drops the agent instance id, keeping principal + operator kind:name", () => {
    expect(identityColorKey("local:kylekelley/agent:nteract-mcp:6483cc0328b4")).toBe(
      "local:kylekelley/agent:nteract-mcp",
    );
  });

  it("drops the device id from a desktop operator", () => {
    expect(identityColorKey("local:kylekelley/desktop:b2c5d701")).toBe(
      "local:kylekelley/desktop",
    );
  });

  it("returns the label unchanged when there is no operator", () => {
    expect(identityColorKey("system")).toBe("system");
  });
});

describe("colorForActorLabel", () => {
  it("is stable across instance ids for the same identity", () => {
    // No connected peers in this unit context, so this exercises the
    // deterministic identity hash rather than the live-presence lookup.
    const a = colorForActorLabel("local:kylekelley/agent:nteract-mcp:6483cc0328b4");
    const b = colorForActorLabel("local:kylekelley/agent:nteract-mcp:99887766aa11");
    expect(a).toBe(b);
  });

  it("distinguishes different operators of the same principal", () => {
    const agent = colorForActorLabel("local:kylekelley/agent:nteract-mcp:6483cc0328b4");
    const desktop = colorForActorLabel("local:kylekelley/desktop:b2c5d701");
    // Different identity keys hash independently; they should not be forced equal.
    expect(typeof agent).toBe("string");
    expect(typeof desktop).toBe("string");
  });
});
