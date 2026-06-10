import { describe, expect, it, vi } from "vite-plus/test";
import { type OutputBlobResolver, resolveContentRef, resolveManifest } from "../output-manifest";

function fakeBlobResolver(blobs: Record<string, string>): OutputBlobResolver {
  return {
    url(ref: { blob: string }) {
      return `https://outputs.example.test/blob/${ref.blob}`;
    },
    fetch: vi.fn(async (ref) => {
      const body = blobs[ref.blob];
      return new Response(body ?? "", {
        status: body == null ? 404 : 200,
      });
    }),
  };
}

describe("resolveContentRef blob fetch coalescing", () => {
  it("shares one fetch across concurrent resolutions of the same ref", async () => {
    const resolver = fakeBlobResolver({ abc123: "shared text" });

    const [first, second, third] = await Promise.all([
      resolveContentRef({ blob: "abc123" }, resolver),
      resolveContentRef({ blob: "abc123" }, resolver),
      resolveContentRef({ blob: "abc123" }, resolver),
    ]);

    expect(first).toBe("shared text");
    expect(second).toBe("shared text");
    expect(third).toBe("shared text");
    expect(resolver.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce distinct blob hashes", async () => {
    const resolver = fakeBlobResolver({ aaa: "one", bbb: "two" });

    const [a, b] = await Promise.all([
      resolveContentRef({ blob: "aaa" }, resolver),
      resolveContentRef({ blob: "bbb" }, resolver),
    ]);

    expect(a).toBe("one");
    expect(b).toBe("two");
    expect(resolver.fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches again after the in-flight request settles", async () => {
    const resolver = fakeBlobResolver({ abc123: "text" });

    await resolveContentRef({ blob: "abc123" }, resolver);
    await resolveContentRef({ blob: "abc123" }, resolver);

    expect(resolver.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects all coalesced callers and retries fresh after a failure", async () => {
    const resolver = fakeBlobResolver({});

    const results = await Promise.allSettled([
      resolveContentRef({ blob: "missing" }, resolver),
      resolveContentRef({ blob: "missing" }, resolver),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    expect(resolver.fetch).toHaveBeenCalledTimes(1);

    await expect(resolveContentRef({ blob: "missing" }, resolver)).rejects.toThrow(
      "Failed to fetch blob missing: 404",
    );
    expect(resolver.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce across distinct resolver instances", async () => {
    const first = fakeBlobResolver({ abc123: "from first" });
    const second = fakeBlobResolver({ abc123: "from second" });

    const [a, b] = await Promise.all([
      resolveContentRef({ blob: "abc123" }, first),
      resolveContentRef({ blob: "abc123" }, second),
    ]);

    expect(a).toBe("from first");
    expect(b).toBe("from second");
    expect(first.fetch).toHaveBeenCalledTimes(1);
    expect(second.fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces port-number inputs across normalize calls", async () => {
    const fetchMock = vi.fn(async () => new Response("port text", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const [a, b] = await Promise.all([
        resolveContentRef({ blob: "abc123" }, 9123),
        resolveContentRef({ blob: "abc123" }, 9123),
      ]);

      expect(a).toBe("port text");
      expect(b).toBe("port text");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9123/blob/abc123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not coalesce the same hash across different ports", async () => {
    const fetchMock = vi.fn(
      async (url: string) => new Response(`from ${new URL(url).port}`, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const [a, b] = await Promise.all([
        resolveContentRef({ blob: "abc123" }, 9123),
        resolveContentRef({ blob: "abc123" }, 9124),
      ]);

      expect(a).toBe("from 9123");
      expect(b).toBe("from 9124");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("coalesces text blob fetches reached through resolveManifest", async () => {
    const resolver = fakeBlobResolver({ shared: "blob body" });

    const manifests = await Promise.all([
      resolveManifest(
        {
          output_id: "out-1",
          output_type: "stream",
          name: "stdout",
          text: { blob: "shared" },
        },
        resolver,
      ),
      resolveManifest(
        {
          output_id: "out-2",
          output_type: "stream",
          name: "stdout",
          text: { blob: "shared" },
        },
        resolver,
      ),
    ]);

    expect(manifests[0]).toMatchObject({ output_id: "out-1", text: "blob body" });
    expect(manifests[1]).toMatchObject({ output_id: "out-2", text: "blob body" });
    expect(resolver.fetch).toHaveBeenCalledTimes(1);
  });
});
