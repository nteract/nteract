import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  cachedActorName,
  clearActorNameCacheForTests,
  rememberActorName,
} from "../actor-name-cache";

afterEach(() => {
  clearActorNameCacheForTests();
});

describe("actor-name-cache", () => {
  it("remembers a display name keyed on the durable identity", () => {
    rememberActorName("local:kylekelley/agent:nteract-mcp:6483cc", "Claude Code");
    // A later session of the same agent (different instance id) resolves the name.
    expect(cachedActorName("local:kylekelley/agent:nteract-mcp:99aa")).toBe("Claude Code");
  });

  it("returns undefined for an unseen actor", () => {
    expect(cachedActorName("local:kylekelley/agent:other:1")).toBeUndefined();
  });

  it("ignores empty inputs", () => {
    rememberActorName("", "Nobody");
    rememberActorName("local:kylekelley/desktop:abc", "");
    expect(cachedActorName("local:kylekelley/desktop:abc")).toBeUndefined();
  });
});
