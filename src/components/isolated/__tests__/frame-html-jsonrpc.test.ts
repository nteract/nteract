/**
 * Tests for JSON-RPC message handling in the bootstrap HTML.
 *
 * The bootstrap HTML's inline script handles both legacy { type, payload }
 * and JSON-RPC 2.0 { jsonrpc: "2.0", method, params } formats. These tests
 * verify the JSON-RPC routing path works correctly.
 */

import { describe, expect, it } from "vite-plus/test";
import { generateFrameHtml } from "../frame-html";

describe("bootstrap HTML JSON-RPC support", () => {
  const html = generateFrameHtml();
  const source = html.replace(/"/g, "'");

  it("checks for jsonrpc 2.0 format before legacy format", () => {
    // The handler should check data.jsonrpc === '2.0' early
    expect(source).toContain("data.jsonrpc === '2.0'");
  });

  it("routes nteract/search to handleSearch", () => {
    expect(source).toContain("case 'nteract/search':");
    expect(html).toContain("handleSearch(params)");
  });

  it("routes nteract/searchNavigate to handleSearchNavigate", () => {
    expect(source).toContain("case 'nteract/searchNavigate':");
    expect(html).toContain("handleSearchNavigate(params)");
  });

  it("routes nteract/eval to handleEval", () => {
    expect(source).toContain("case 'nteract/eval':");
    expect(html).toContain("handleEval(params, event)");
  });

  it("passes the MessageEvent into eval without relying on a global event", () => {
    expect(html).toContain("handleEval(params, event)");
    expect(html).toContain("handleEval(payload, event)");
    expect(html).toContain("function handleEval(payload, messageEvent)");
    expect(html).toContain("window.currentMessage = messageEvent");
  });

  it("routes nteract/renderOutput with React gate", () => {
    expect(source).toContain("case 'nteract/renderOutput':");
  });

  it("routes nteract/theme with React gate", () => {
    expect(source).toContain("case 'nteract/theme':");
  });

  it("routes nteract/clearOutputs with React gate", () => {
    expect(source).toContain("case 'nteract/clearOutputs':");
  });

  it("routes nteract/ping to handlePing", () => {
    expect(source).toContain("case 'nteract/ping':");
  });

  it("sends outgoing messages in JSON-RPC format via sendRpc", () => {
    // sendRpc helper should produce { jsonrpc: '2.0', method, params }
    expect(html).toContain("function sendRpc(method, params)");
    expect(source).toContain("jsonrpc: '2.0'");
  });

  it("sends ready in legacy format via sendLegacy", () => {
    // Ready must stay legacy (host creates transport in response)
    expect(source).toContain("sendLegacy('ready'");
    expect(html).toContain("function sendLegacy(type, payload)");
  });

  it("sends search_results as JSON-RPC", () => {
    expect(source).toContain("sendRpc('nteract/searchResults'");
  });

  it("sends render_complete as JSON-RPC", () => {
    expect(source).toContain("sendRpc('nteract/renderComplete'");
  });

  it("sends resize as JSON-RPC", () => {
    expect(source).toContain("sendRpc('nteract/resize'");
  });

  it("sends link_click as JSON-RPC", () => {
    expect(source).toContain("sendRpc('nteract/linkClick'");
  });

  it("sends error as JSON-RPC", () => {
    expect(source).toContain("sendRpc('nteract/error'");
  });

  it("sends eval_result as JSON-RPC", () => {
    expect(source).toContain("sendRpc('nteract/evalResult'");
  });

  it("preserves legacy handler as fallback", () => {
    // Legacy switch should still exist after the JSON-RPC block
    expect(source).toContain("case 'search':");
    expect(source).toContain("case 'eval':");
    expect(source).toContain("case 'render':");
  });
});
