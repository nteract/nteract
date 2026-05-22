import { describe, expect, it, vi } from "vite-plus/test";

import { createBlobResolver, createHttpBlobResolver, normalizeBlobResolver } from "../src";

describe("blob resolver helpers", () => {
  it("creates daemon HTTP blob URLs from a local port", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
    const resolver = createHttpBlobResolver(8765, fetchImpl);
    const ref = { blob: "sha256:abc", size: 12 };

    expect(resolver.port).toBe(8765);
    expect(resolver.url(ref)).toBe("http://127.0.0.1:8765/blob/sha256:abc");

    const response = await resolver.fetch(ref);

    expect(await response.text()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8765/blob/sha256:abc");
  });

  it("creates host-agnostic resolvers without exposing a daemon port", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("cloud"));
    const resolver = createBlobResolver({
      url: (ref) => `/api/n/notebook-1/blobs/${encodeURIComponent(ref.blob)}`,
      fetchImpl,
      requestInit: (ref) => ({
        headers: { "X-Blob-Size": String(ref.size ?? 0) },
      }),
    });
    const ref = { blob: "sha256:abc", size: 42 };

    expect(resolver.port).toBeUndefined();
    expect(resolver.url(ref)).toBe("/api/n/notebook-1/blobs/sha256%3Aabc");

    const response = await resolver.fetch(ref);

    expect(await response.text()).toBe("cloud");
    expect(fetchImpl).toHaveBeenCalledWith("/api/n/notebook-1/blobs/sha256%3Aabc", {
      headers: { "X-Blob-Size": "42" },
    });
  });

  it("normalizes legacy numeric ports to daemon HTTP resolvers", () => {
    const resolver = normalizeBlobResolver(4321);

    expect(resolver.port).toBe(4321);
    expect(resolver.url({ blob: "hash" })).toBe("http://127.0.0.1:4321/blob/hash");
  });

  it("passes resolver objects through unchanged", () => {
    const resolver = createBlobResolver({
      url: (ref) => `https://outputs.example/${ref.blob}`,
    });

    expect(normalizeBlobResolver(resolver)).toBe(resolver);
  });
});
