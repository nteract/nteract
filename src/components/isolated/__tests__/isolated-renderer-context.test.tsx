import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  _resetBundleCache,
  IsolatedRendererProvider,
  useHasIsolatedOutputs,
  useIsolatedRenderer,
  useRegisterIsolatedOutput,
} from "../isolated-renderer-context";

function Probe({ id }: { id: string }) {
  const { rendererCode, rendererCss, isLoading, error, lastError, retry } = useIsolatedRenderer();
  return (
    <div
      data-testid={id}
      data-loading={isLoading ? "true" : "false"}
      data-error={error?.message ?? ""}
      data-last-error={lastError?.message ?? ""}
      data-code={rendererCode ?? ""}
      data-css={rendererCss ?? ""}
    >
      <button type="button" data-testid={`${id}-retry`} onClick={retry}>
        retry
      </button>
    </div>
  );
}

function probeState(id: string) {
  const node = screen.getByTestId(id);
  return {
    loading: node.getAttribute("data-loading"),
    error: node.getAttribute("data-error"),
    lastError: node.getAttribute("data-last-error"),
    code: node.getAttribute("data-code"),
    css: node.getAttribute("data-css"),
  };
}

describe("IsolatedRendererProvider retry behavior", () => {
  beforeEach(() => {
    _resetBundleCache();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetBundleCache();
  });

  it("serves the bundle to consumers when the loader succeeds", async () => {
    const loader = vi.fn(async () => ({ rendererCode: "code-v1", rendererCss: "css-v1" }));

    render(
      <IsolatedRendererProvider loader={loader}>
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(probeState("a")).toMatchObject({ loading: "false", error: "", code: "code-v1" });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("retries on the backoff ladder before surfacing anything to consumers", async () => {
    let failuresRemaining = 2;
    const loader = vi.fn(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("Failed to fetch renderer JS: 404");
      }
      return { rendererCode: "code-v1", rendererCss: "css-v1" };
    });

    render(
      <IsolatedRendererProvider loader={loader}>
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(loader).toHaveBeenCalledTimes(1);
    // Mid-ladder: still quietly loading, no error surfaced.
    expect(probeState("a")).toMatchObject({ loading: "true", error: "" });

    // First rung is exactly 150ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(probeState("a")).toMatchObject({ loading: "true", error: "" });

    // Second rung (500ms) recovers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(loader).toHaveBeenCalledTimes(3);
    expect(probeState("a")).toMatchObject({ loading: "false", error: "", code: "code-v1" });
  });

  it("surfaces a terminal error after the ladder exhausts and recovers via retry()", async () => {
    let healed = false;
    const loader = vi.fn(async () => {
      if (!healed) throw new Error("Failed to fetch renderer JS: 503");
      return { rendererCode: "code-v2", rendererCss: "css-v2" };
    });

    render(
      <IsolatedRendererProvider loader={loader}>
        <Probe id="a" />
        <Probe id="b" />
      </IsolatedRendererProvider>,
    );

    // Boundary-pin every rung of THIS ladder (it has its own constant,
    // separate from the wasm client's): 150 / 500 / 1500 exactly.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loader).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1499);
    });
    expect(loader).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // 4 attempts (1 + 3 retries), then the error reaches every consumer.
    expect(loader).toHaveBeenCalledTimes(4);
    expect(probeState("a")).toMatchObject({
      loading: "false",
      error: "Failed to fetch renderer JS: 503",
    });
    expect(probeState("b")).toMatchObject({
      loading: "false",
      error: "Failed to fetch renderer JS: 503",
    });

    // One consumer's retry un-blanks every mounted consumer at once.
    healed = true;
    await act(async () => {
      screen.getByTestId("a-retry").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(loader).toHaveBeenCalledTimes(5);
    expect(probeState("a")).toMatchObject({ loading: "false", error: "", code: "code-v2" });
    expect(probeState("b")).toMatchObject({ loading: "false", error: "", code: "code-v2" });
  });

  it("propagates recovery across separate provider instances via the shared cache", async () => {
    let healed = false;
    const loader = vi.fn(async () => {
      if (!healed) throw new Error("Failed to fetch renderer CSS: 404");
      return { rendererCode: "code-v3", rendererCss: "css-v3" };
    });

    render(
      <>
        <IsolatedRendererProvider loader={loader}>
          <Probe id="a" />
        </IsolatedRendererProvider>
        <IsolatedRendererProvider loader={loader}>
          <Probe id="b" />
        </IsolatedRendererProvider>
      </>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 500 + 1500);
    });
    expect(probeState("a").error).toBe("Failed to fetch renderer CSS: 404");
    expect(probeState("b").error).toBe("Failed to fetch renderer CSS: 404");

    healed = true;
    await act(async () => {
      screen.getByTestId("b-retry").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(probeState("a")).toMatchObject({ loading: "false", error: "", code: "code-v3" });
    expect(probeState("b")).toMatchObject({ loading: "false", error: "", code: "code-v3" });
  });

  it("retry() is a no-op while loading or after success", async () => {
    const loader = vi.fn(async () => ({ rendererCode: "code", rendererCss: "css" }));

    render(
      <IsolatedRendererProvider loader={loader}>
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );

    await act(async () => {
      // Click while the initial load is still in flight.
      screen.getByTestId("a-retry").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      // Click again after success.
      screen.getByTestId("a-retry").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(probeState("a")).toMatchObject({ loading: "false", error: "", code: "code" });
  });

  it("fetches js and css from basePath and reports HTTP failures", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("isolated-renderer.js")) {
        return new Response("js-code");
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IsolatedRendererProvider basePath="/renderer-assets">
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 500 + 1500);
    });

    expect(probeState("a").error).toBe("Failed to fetch renderer CSS: 404");
    expect(
      fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.endsWith(".css"))
        .length,
    ).toBe(4);
    vi.unstubAllGlobals();
  });

  it("fetches manifest-named (content-hashed) bundle files when assetNames are provided", async () => {
    const fetched: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(String(input).endsWith(".css") ? "css-code" : "js-code");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IsolatedRendererProvider
        basePath="/renderer-assets"
        assetNames={{
          js: "isolated-renderer.0123456789abcdef.js",
          css: "isolated-renderer.fedcba9876543210.css",
        }}
      >
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetched).toEqual([
      "/renderer-assets/isolated-renderer.0123456789abcdef.js",
      "/renderer-assets/isolated-renderer.fedcba9876543210.css",
    ]);
    expect(probeState("a")).toMatchObject({ loading: "false", error: "", code: "js-code" });
    vi.unstubAllGlobals();
  });

  it("defaults to the stable bundle filenames without assetNames", async () => {
    const fetched: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IsolatedRendererProvider basePath="/renderer-assets">
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetched).toEqual([
      "/renderer-assets/isolated-renderer.js",
      "/renderer-assets/isolated-renderer.css",
    ]);
    vi.unstubAllGlobals();
  });

  it("keeps lastError sticky through an in-flight retry so degraded UI does not flap", async () => {
    const loader = vi.fn(async () => {
      throw new Error("Failed to fetch renderer JS: 503");
    });

    render(
      <IsolatedRendererProvider loader={loader}>
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 500 + 1500);
    });
    expect(probeState("a")).toMatchObject({
      loading: "false",
      error: "Failed to fetch renderer JS: 503",
      lastError: "Failed to fetch renderer JS: 503",
    });

    // Mid-retry: terminal `error` clears (the ladder is running) but
    // `lastError` keeps the failure visible — consumers keep their
    // fallback instead of remounting blank frames.
    await act(async () => {
      screen.getByTestId("a-retry").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(probeState("a")).toMatchObject({
      loading: "true",
      error: "",
      lastError: "Failed to fetch renderer JS: 503",
    });

    // Exhausting again restores the terminal error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 500 + 1500);
    });
    expect(probeState("a")).toMatchObject({
      loading: "false",
      error: "Failed to fetch renderer JS: 503",
    });
  });

  it("falls back to the stable bundle names once after a hashed-name ladder exhausts", async () => {
    const fetched: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (/\.[a-f0-9]{12,64}\.(?:js|css)$/.test(url)) {
        return new Response("gone", { status: 404 });
      }
      return new Response(url.endsWith(".css") ? "stable-css" : "stable-js");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <IsolatedRendererProvider
        basePath="/renderer-assets"
        assetNames={{
          js: "isolated-renderer.0123456789abcdef.js",
          css: "isolated-renderer.fedcba9876543210.css",
        }}
      >
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 500 + 1500);
    });

    // Four hashed-pair attempts, then ONE stable-pair attempt (js and css
    // fall back together so the pair stays deploy-consistent).
    expect(fetched.slice(-2)).toEqual([
      "/renderer-assets/isolated-renderer.js",
      "/renderer-assets/isolated-renderer.css",
    ]);
    expect(fetched.filter((url) => url.includes("0123456789abcdef"))).toHaveLength(4);
    expect(probeState("a")).toMatchObject({
      loading: "false",
      error: "",
      lastError: "",
      code: "stable-js",
      css: "stable-css",
    });
    vi.unstubAllGlobals();
  });

  it("re-kicks a terminally failed load when the browser comes back online", async () => {
    let healed = false;
    const loader = vi.fn(async () => {
      if (!healed) throw new Error("Failed to fetch renderer JS: 503");
      return { rendererCode: "code-v4", rendererCss: "css-v4" };
    });

    render(
      <IsolatedRendererProvider loader={loader}>
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 500 + 1500);
    });
    expect(probeState("a").error).toBe("Failed to fetch renderer JS: 503");

    healed = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(probeState("a")).toMatchObject({ loading: "false", error: "", code: "code-v4" });
    expect(loader).toHaveBeenCalledTimes(5);
  });

  it("tracks isolated-output presence across mounts", async () => {
    function Watcher() {
      const present = useHasIsolatedOutputs();
      return <div data-testid="watcher" data-present={present ? "true" : "false"} />;
    }
    function IsolatedWell() {
      useRegisterIsolatedOutput(true);
      return null;
    }

    const { rerender } = render(
      <>
        <Watcher />
      </>,
    );
    expect(screen.getByTestId("watcher").getAttribute("data-present")).toBe("false");

    rerender(
      <>
        <Watcher />
        <IsolatedWell />
      </>,
    );
    expect(screen.getByTestId("watcher").getAttribute("data-present")).toBe("true");

    rerender(
      <>
        <Watcher />
      </>,
    );
    expect(screen.getByTestId("watcher").getAttribute("data-present")).toBe("false");
  });

  it("reports a configuration error when neither basePath nor loader is provided", async () => {
    render(
      <IsolatedRendererProvider>
        <Probe id="a" />
      </IsolatedRendererProvider>,
    );

    expect(probeState("a").loading).toBe("false");
    expect(probeState("a").error).toContain("requires either 'basePath' or 'loader'");
  });
});
