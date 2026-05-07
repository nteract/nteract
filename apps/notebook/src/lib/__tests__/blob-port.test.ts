// @vitest-environment jsdom
import type { NotebookHost } from "@nteract/notebook-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  _testGetGeneration,
  _testReset,
  getBlobResolver,
  getBlobPort,
  refreshBlobPort,
  resetBlobPort,
  setBlobPortHost,
} from "../blob-port";

const mockResolver = vi.fn();

function resolverFor(port: number) {
  return {
    port,
    url: ({ blob }: { blob: string }) => `http://127.0.0.1:${port}/blob/${blob}`,
    fetch: vi.fn(),
  };
}

/** Minimal host stub: only `blobs.resolver()` is exercised. */
function makeHost(): NotebookHost {
  return {
    name: "test",
    blobs: {
      port: async () => (await mockResolver()).port,
      resolver: mockResolver,
    },
  } as unknown as NotebookHost;
}

beforeEach(() => {
  _testReset();
  setBlobPortHost(makeHost());
});

afterEach(() => {
  mockResolver.mockReset();
  setBlobPortHost(null);
});

describe("blob-port store", () => {
  it("starts with null", () => {
    expect(getBlobPort()).toBeNull();
    expect(getBlobResolver()).toBeNull();
  });

  it("refreshBlobPort fetches and caches the port", async () => {
    mockResolver.mockResolvedValueOnce(resolverFor(12345));
    const port = await refreshBlobPort();
    expect(port).toBe(12345);
    expect(getBlobPort()).toBe(12345);
    expect(getBlobResolver()?.url({ blob: "abc" })).toBe("http://127.0.0.1:12345/blob/abc");
  });

  it("deduplicates concurrent refresh calls", async () => {
    mockResolver.mockResolvedValueOnce(resolverFor(9999));
    const [a, b, c] = await Promise.all([
      refreshBlobPort(),
      refreshBlobPort(),
      refreshBlobPort(),
    ]);
    expect(a).toBe(9999);
    expect(b).toBe(9999);
    expect(c).toBe(9999);
    expect(mockResolver).toHaveBeenCalledTimes(1);
  });

  it("resetBlobPort clears the port", async () => {
    mockResolver.mockResolvedValueOnce(resolverFor(12345));
    await refreshBlobPort();
    expect(getBlobPort()).toBe(12345);

    resetBlobPort();
    expect(getBlobPort()).toBeNull();
    expect(getBlobResolver()).toBeNull();
  });

  it("resetBlobPort increments generation", () => {
    const gen0 = _testGetGeneration();
    resetBlobPort();
    expect(_testGetGeneration()).toBe(gen0 + 1);
  });

  it("discards stale refresh after reset", async () => {
    let resolveFetch: (v: ReturnType<typeof resolverFor>) => void;
    mockResolver.mockReturnValueOnce(
      new Promise<ReturnType<typeof resolverFor>>((r) => {
        resolveFetch = r;
      }),
    );

    const refreshPromise = refreshBlobPort();

    resetBlobPort();
    expect(getBlobPort()).toBeNull();

    resolveFetch!(resolverFor(54321));
    await refreshPromise;

    expect(getBlobPort()).toBeNull();
  });

  it("retries on failure", async () => {
    mockResolver
      .mockRejectedValueOnce(new Error("not ready"))
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce(resolverFor(7777));

    const port = await refreshBlobPort();
    expect(port).toBe(7777);
    expect(mockResolver).toHaveBeenCalledTimes(3);
  });

  it("allows fresh refresh after reset", async () => {
    mockResolver.mockResolvedValueOnce(resolverFor(1111));
    await refreshBlobPort();
    expect(getBlobPort()).toBe(1111);

    resetBlobPort();
    expect(getBlobPort()).toBeNull();

    mockResolver.mockResolvedValueOnce(resolverFor(2222));
    await refreshBlobPort();
    expect(getBlobPort()).toBe(2222);
  });
});
