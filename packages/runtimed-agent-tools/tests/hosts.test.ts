import { describe, expect, it } from "vitest";

import OpenCodePlugin from "../src/opencode.js";
import KiloPlugin from "../src/kilo.js";

describe("host entrypoints", () => {
  it("exports an OpenCode plugin function", () => {
    expect(OpenCodePlugin).toBeTypeOf("function");
  });

  it("exports a Kilo server plugin descriptor", () => {
    expect(KiloPlugin).toMatchObject({
      id: "@runtimed/agent-tools",
      server: expect.any(Function),
    });
  });
});
