import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDaemonRendererPluginLoader } from "../shared-renderer-plugin-loader";

describe("createDaemonRendererPluginLoader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
