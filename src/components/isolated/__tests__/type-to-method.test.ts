/**
 * Tests for TYPE_TO_METHOD mapping in isolated-frame.tsx.
 *
 * Verifies that every legacy message type that goes through send()
 * has a corresponding JSON-RPC method mapping, and that the mapping
 * values match the constants in rpc-methods.ts.
 */

import { describe, expect, it } from "vite-plus/test";
import { TYPE_TO_METHOD } from "../isolated-frame-runtime";

describe("TYPE_TO_METHOD mapping", () => {
  it("maps all host→iframe legacy types to JSON-RPC methods", () => {
    // Every legacy type that CommBridgeManager or IsolatedFrame.send() uses
    const requiredTypes = [
      "render",
      "render_batch",
      "theme",
      "clear",
      "eval",
      "install_renderer",
      "ping",
      "search",
      "search_navigate",
      "comm_open",
      "comm_msg",
      "comm_close",
      "widget_snapshot",
      "bridge_ready",
      "widget_state",
      "bokeh_session_patch",
      "bokeh_session_state",
    ];

    for (const type of requiredTypes) {
      expect(TYPE_TO_METHOD[type], `Missing mapping for legacy type "${type}"`).toBeDefined();
    }
  });

  it("all mapped methods have nteract/ prefix", () => {
    for (const [type, method] of Object.entries(TYPE_TO_METHOD)) {
      expect(method, `Method for "${type}" should have nteract/ prefix`).toMatch(/^nteract\//);
    }
  });

  it("maps to correct JSON-RPC method names", () => {
    expect(TYPE_TO_METHOD.render).toBe("nteract/renderOutput");
    expect(TYPE_TO_METHOD.render_batch).toBe("nteract/renderBatch");
    expect(TYPE_TO_METHOD.theme).toBe("nteract/theme");
    expect(TYPE_TO_METHOD.clear).toBe("nteract/clearOutputs");
    expect(TYPE_TO_METHOD.eval).toBe("nteract/eval");
    expect(TYPE_TO_METHOD.install_renderer).toBe("nteract/installRenderer");
    expect(TYPE_TO_METHOD.search).toBe("nteract/search");
    expect(TYPE_TO_METHOD.search_navigate).toBe("nteract/searchNavigate");
    expect(TYPE_TO_METHOD.comm_open).toBe("nteract/commOpen");
    expect(TYPE_TO_METHOD.comm_msg).toBe("nteract/commMsg");
    expect(TYPE_TO_METHOD.comm_close).toBe("nteract/commClose");
    expect(TYPE_TO_METHOD.widget_snapshot).toBe("nteract/widgetSnapshot");
    expect(TYPE_TO_METHOD.bridge_ready).toBe("nteract/bridgeReady");
    expect(TYPE_TO_METHOD.widget_state).toBe("nteract/widgetState");
    expect(TYPE_TO_METHOD.bokeh_session_patch).toBe("nteract/bokehSessionPatch");
    expect(TYPE_TO_METHOD.bokeh_session_state).toBe("nteract/bokehSessionState");
  });

  it("has no duplicate method values", () => {
    const methods = Object.values(TYPE_TO_METHOD);
    const unique = new Set(methods);
    expect(unique.size).toBe(methods.length);
  });
});
