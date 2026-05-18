/**
 * Tests for IsolatedFrameController — the framework-agnostic RxJS-based
 * orchestrator that owns iframe lifecycle, transport, and message routing.
 *
 * These tests drive the controller against a stub iframe element with a
 * fake `contentWindow`, exercising the state machine + observable surface
 * without actually loading any HTML.
 */

import { firstValueFrom, take, toArray } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FrameLifecycleState } from "../isolated-frame-controller";
import { IsolatedFrameController } from "../isolated-frame-controller";
import {
  NTERACT_INTERACTION_STATE,
  NTERACT_LINK_CLICK,
  NTERACT_RENDERER_READY,
  NTERACT_RENDER_OUTPUT,
  NTERACT_RESIZE,
  NTERACT_THEME,
} from "../rpc-methods";

interface FakeIframe {
  element: HTMLIFrameElement;
  contentWindow: Window;
  posts: Array<{ message: unknown; origin: string }>;
}

function createFakeIframe(): FakeIframe {
  const posts: FakeIframe["posts"] = [];
  const contentWindow = {
    postMessage: vi.fn((message: unknown, origin: string) => {
      posts.push({ message, origin });
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window;

  const element = {
    contentWindow,
  } as unknown as HTMLIFrameElement;

  return { element, contentWindow, posts };
}

/**
 * Fires a MessageEvent at the window from the iframe's contentWindow.
 * The controller listens for messages whose `source` matches the iframe.
 */
function dispatchFromIframe(iframe: FakeIframe, data: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: iframe.contentWindow as MessageEventSource,
      data,
    }),
  );
}

describe("IsolatedFrameController", () => {
  let iframe: FakeIframe;

  beforeEach(() => {
    iframe = createFakeIframe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("lifecycle state machine", () => {
    it("starts in 'booting'", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      expect(controller.state).toBe("booting");
      controller.dispose();
    });

    it("transitions booting → bootstrapped → installing on first ready", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      const seen: FrameLifecycleState[] = [];
      controller.state$.subscribe((s) => seen.push(s));

      dispatchFromIframe(iframe, { type: "ready" });

      expect(seen).toContain("booting");
      expect(seen).toContain("bootstrapped");
      expect(seen).toContain("installing");
      controller.dispose();
    });

    it("reaches 'ready' on JSON-RPC nteract/rendererReady", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      dispatchFromIframe(iframe, { type: "ready" });

      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RENDERER_READY,
        params: {},
      });
      expect(controller.state).toBe("ready");
      controller.dispose();
    });

    it("treats a second 'ready' as a reload", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      dispatchFromIframe(iframe, { type: "ready" });
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RENDERER_READY,
        params: {},
      });
      expect(controller.state).toBe("ready");

      const seen: FrameLifecycleState[] = [];
      controller.state$.subscribe((s) => seen.push(s));

      dispatchFromIframe(iframe, { type: "ready" });
      expect(seen).toContain("reloading");
      expect(seen).toContain("bootstrapped");
      expect(controller.state).toBe("installing");
      controller.dispose();
    });
  });

  describe("send queue", () => {
    it("queues interaction_state until ready, then flushes via JSON-RPC", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      // Pre-ready: nothing must slip through immediately.
      controller.send({ type: "interaction_state", payload: { active: true } });
      const preReady = iframe.posts.filter(
        (p) => (p.message as { method?: string }).method === NTERACT_INTERACTION_STATE,
      );
      expect(preReady).toHaveLength(0);

      dispatchFromIframe(iframe, { type: "ready" });
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RENDERER_READY,
        params: {},
      });
      const postReady = iframe.posts.filter(
        (p) => (p.message as { method?: string }).method === NTERACT_INTERACTION_STATE,
      );
      expect(postReady).toHaveLength(1);
      expect((postReady[0].message as { params: unknown }).params).toEqual({ active: true });
      controller.dispose();
    });

    it("throws on send() with a type that has no JSON-RPC method", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      expect(() =>
        controller.send({ type: "unknown" as never, payload: {} as never } as never),
      ).toThrow(/no JSON-RPC method/);
      controller.dispose();
    });

    it("queues render until ready, then flushes via JSON-RPC", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });

      controller.render({ mimeType: "text/plain", data: "hi" });
      // Nothing JSON-RPC was posted yet (only theme via raw postMessage
      // would be in the post queue, and that only after `ready`).
      const renderPosts = iframe.posts.filter(
        (p) => (p.message as { method?: string }).method === NTERACT_RENDER_OUTPUT,
      );
      expect(renderPosts).toHaveLength(0);

      dispatchFromIframe(iframe, { type: "ready" });
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RENDERER_READY,
        params: {},
      });

      const flushed = iframe.posts.filter(
        (p) => (p.message as { method?: string }).method === NTERACT_RENDER_OUTPUT,
      );
      expect(flushed).toHaveLength(1);
      expect((flushed[0].message as { params: unknown }).params).toEqual({
        mimeType: "text/plain",
        data: "hi",
      });
      controller.dispose();
    });

    it("drops queued sends on reload", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });

      // Get to ready
      dispatchFromIframe(iframe, { type: "ready" });
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RENDERER_READY,
        params: {},
      });
      iframe.posts.length = 0;

      // Send a reload signal BEFORE the next renderer_ready
      dispatchFromIframe(iframe, { type: "ready" });
      // Now queue something during the reload window
      controller.render({ mimeType: "text/plain", data: "during-reload" });
      // Another reload — queued items must be dropped
      dispatchFromIframe(iframe, { type: "ready" });

      // Restore to ready
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RENDERER_READY,
        params: {},
      });

      const renderPosts = iframe.posts.filter(
        (p) => (p.message as { method?: string }).method === NTERACT_RENDER_OUTPUT,
      );
      expect(renderPosts).toHaveLength(0);
      controller.dispose();
    });
  });

  describe("theme application", () => {
    it("posts a theme message on bootstrap", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
        initialTheme: { isDark: false, colorTheme: "cream" },
      });
      dispatchFromIframe(iframe, { type: "ready" });

      const themePost = iframe.posts.find((p) => (p.message as { type?: string }).type === "theme");
      expect(themePost).toBeDefined();
      expect((themePost!.message as { payload: unknown }).payload).toEqual({
        isDark: false,
        colorTheme: "cream",
      });
      controller.dispose();
    });

    it("routes setTheme via JSON-RPC once ready", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      dispatchFromIframe(iframe, { type: "ready" });
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RENDERER_READY,
        params: {},
      });
      iframe.posts.length = 0;

      controller.setTheme({ isDark: false, colorTheme: "cream" });

      const themeRpc = iframe.posts.find(
        (p) => (p.message as { method?: string }).method === NTERACT_THEME,
      );
      expect(themeRpc).toBeDefined();
      expect((themeRpc!.message as { params: unknown }).params).toEqual({
        isDark: false,
        colorTheme: "cream",
      });
      controller.dispose();
    });
  });

  describe("observables", () => {
    it("emits resize from JSON-RPC", async () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      dispatchFromIframe(iframe, { type: "ready" });
      const next = firstValueFrom(controller.resize$);
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RESIZE,
        params: { height: 432 },
      });
      await expect(next).resolves.toEqual({ height: 432 });
      controller.dispose();
    });

    it("emits link clicks from JSON-RPC", async () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      dispatchFromIframe(iframe, { type: "ready" });
      const next = firstValueFrom(controller.linkClicks$);
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_LINK_CLICK,
        params: { url: "https://example.com", newTab: true },
      });
      await expect(next).resolves.toEqual({
        url: "https://example.com",
        newTab: true,
      });
      controller.dispose();
    });

    it("emits state transitions in order", async () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      const sequence = firstValueFrom(controller.state$.pipe(take(4), toArray()));
      dispatchFromIframe(iframe, { type: "ready" });
      dispatchFromIframe(iframe, {
        jsonrpc: "2.0",
        method: NTERACT_RENDERER_READY,
        params: {},
      });
      await expect(sequence).resolves.toEqual(["booting", "bootstrapped", "installing", "ready"]);
      controller.dispose();
    });
  });

  describe("renderer bundle injection", () => {
    it("defers bundle injection until rendererCode/css are set", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
      });
      dispatchFromIframe(iframe, { type: "ready" });

      // No eval posts yet — only the bootstrap theme message.
      const evalPosts = iframe.posts.filter(
        (p) => (p.message as { type?: string }).type === "eval",
      );
      expect(evalPosts).toHaveLength(0);
      // State is bootstrapped, not installing, because the bundle is missing.
      expect(controller.state).toBe("bootstrapped");

      controller.setRendererBundle("/*code*/", "body{}");
      const evalPostsAfter = iframe.posts.filter(
        (p) => (p.message as { type?: string }).type === "eval",
      );
      // Two eval posts: CSS then JS wrapper
      expect(evalPostsAfter).toHaveLength(2);
      expect(controller.state).toBe("installing");
      controller.dispose();
    });
  });

  describe("dispose", () => {
    it("removes the window message listener", () => {
      const controller = new IsolatedFrameController({
        iframe: iframe.element,
        rendererCode: "/*code*/",
        rendererCss: "body{}",
      });
      controller.dispose();
      // After dispose, dispatching a 'ready' must not transition state.
      const before = controller.state;
      dispatchFromIframe(iframe, { type: "ready" });
      expect(controller.state).toBe(before);
    });
  });
});
