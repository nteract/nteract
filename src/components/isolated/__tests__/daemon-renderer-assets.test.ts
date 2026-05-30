import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createDaemonRendererPluginLoader,
  daemonOutputFrameUrl,
  daemonRendererAssetsBaseUrl,
} from "../daemon-renderer-assets";

describe("daemon renderer assets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds daemon output frame and plugin asset base URLs from the blob base URL", () => {
    expect(daemonOutputFrameUrl("http://localhost:47830/")).toBeNull();
    expect(daemonRendererAssetsBaseUrl("http://localhost:47830/")).toBe(
      "http://localhost:47830/plugins/",
    );
    expect(daemonOutputFrameUrl(undefined)).toBeNull();
    expect(daemonRendererAssetsBaseUrl(undefined)).toBeUndefined();
  });

  it("uses the daemon output frame only when the host frame CSP allows it", () => {
    expect(
      daemonOutputFrameUrl("http://localhost:47830/", {
        frameDomains: ["http://localhost:47830"],
      }),
    ).toBe("http://localhost:47830/output-frame");
    expect(
      daemonOutputFrameUrl("http://localhost:47830/", {
        frameDomains: ["http://localhost:*"],
      }),
    ).toBe("http://localhost:47830/output-frame");
    expect(
      daemonOutputFrameUrl("https://renderer.example.test/", {
        frameDomains: ["https://*.example.test"],
      }),
    ).toBe("https://renderer.example.test/output-frame");
    expect(
      daemonOutputFrameUrl("https://renderer.example.test/", {
        frameDomains: ["https://renderer.example.test:443"],
      }),
    ).toBe("https://renderer.example.test/output-frame");
    expect(
      daemonOutputFrameUrl("http://localhost/", {
        frameDomains: ["http://localhost:80"],
      }),
    ).toBe("http://localhost/output-frame");
    expect(
      daemonOutputFrameUrl("http://localhost:47830/", {
        frameDomains: ["https://outputs.example.test"],
      }),
    ).toBeNull();
    expect(daemonOutputFrameUrl("http://localhost:47830/", { frameDomains: [] })).toBeNull();
  });

  it("fetches raw renderer plugin assets from the daemon renderer-plugin route", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/renderer-plugins/markdown.js")) {
        return new Response("module.exports = { install() {} }");
      }
      if (pathname.endsWith("/renderer-plugins/markdown.css")) {
        return new Response(".markdown-output{}");
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const loader = createDaemonRendererPluginLoader("http://localhost:47830");
    const plugin = await loader?.("text/markdown");

    expect(plugin).toEqual({
      id: "markdown",
      code: "module.exports = { install() {} }",
      css: ".markdown-output{}",
    });
    expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).pathname).toBe(
      "/renderer-plugins/markdown.js",
    );
    expect(new URL(fetchImpl.mock.calls[1]?.[0] as string).pathname).toBe(
      "/renderer-plugins/markdown.css",
    );
  });

  it("deduplicates concurrent plugin fetches by plugin name", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith(".css") ? "" : "js"));
    vi.stubGlobal("fetch", fetchImpl);

    const loader = createDaemonRendererPluginLoader("http://localhost:47830");
    await Promise.all([loader?.("text/markdown"), loader?.("text/latex")]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns undefined for MIME types rendered by the core isolated bundle", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const loader = createDaemonRendererPluginLoader("http://localhost:47830");

    await expect(loader?.("text/plain")).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
