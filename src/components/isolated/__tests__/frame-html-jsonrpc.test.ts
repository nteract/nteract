/**
 * Tests for JSON-RPC message handling in the bootstrap HTML.
 *
 * The bootstrap HTML's inline script accepts JSON-RPC 2.0
 * { jsonrpc: "2.0", method, params } commands from the host. Bootstrap
 * readiness is the only raw message left because the host creates the
 * transport in response to it.
 */

import { describe, expect, it } from "vite-plus/test";
import { generateFrameHtml } from "../frame-html";

describe("bootstrap HTML JSON-RPC support", () => {
  const html = generateFrameHtml();
  const source = html.replace(/"/g, "'");

  it("requires jsonrpc 2.0 format", () => {
    expect(source).toContain("if (data.jsonrpc !== '2.0') return");
    expect(source).not.toContain("var type = data.type");
    expect(source).not.toContain("var payload = data.payload");
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

  it("sends ready as a raw bootstrap signal", () => {
    // Ready stays raw because the host creates transport in response.
    expect(source).toContain("sendBootstrap('ready'");
    expect(html).toContain("function sendBootstrap(type, payload)");
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

  it("does not accept legacy host command types", () => {
    expect(source).not.toContain("case 'search':");
    expect(source).not.toContain("case 'eval':");
    expect(source).not.toContain("case 'render':");
    expect(source).not.toContain("case 'install_renderer':");
  });
});
