import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  _resetBundleCache,
  IsolatedRendererProvider,
  useIsolatedRenderer,
} from "../isolated-renderer-context";

function Probe({ id }: { id: string }) {
  const { rendererCode, rendererCss, isLoading, error, retry } = useIsolatedRenderer();
  return (
    <div
      data-testid={id}
      data-loading={isLoading ? "true" : "false"}
      data-error={error?.message ?? ""}
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 500 + 1500);
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
