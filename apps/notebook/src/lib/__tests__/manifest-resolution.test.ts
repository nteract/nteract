import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ARROW_STREAM_MANIFEST_MIME,
  createBlobResolver,
  type ContentRef,
  isOutputManifest,
  type OutputManifest,
  resolveContentRef,
  resolveDataBundle,
  resolveManifest,
  resolveManifestSync,
} from "../manifest-resolution";

// ---------------------------------------------------------------------------
// Mock fetch globally for blob-store resolution tests
// ---------------------------------------------------------------------------

const mockFetch =
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// isOutputManifest
// ---------------------------------------------------------------------------

describe("isOutputManifest", () => {
  it("returns true for a stream manifest with inline ContentRef", () => {
    expect(
      isOutputManifest({
        output_id: "manifest-stream-inline",
        output_type: "stream",
        name: "stdout",
        text: { inline: "hello\n" },
      }),
    ).toBe(true);
  });

  it("returns true for a stream manifest with blob ContentRef", () => {
    expect(
      isOutputManifest({
        output_id: "manifest-stream-blob",
        output_type: "stream",
        name: "stdout",
        text: { blob: "abc123", size: 100 },
      }),
    ).toBe(true);
  });

  it("returns true for a display_data manifest", () => {
    expect(
      isOutputManifest({
        output_id: "manifest-display-inline",
        output_type: "display_data",
        data: { "text/plain": { inline: "hi" } },
      }),
    ).toBe(true);
  });

  it("returns true for a display_data manifest with url ContentRef", () => {
    expect(
      isOutputManifest({
        output_id: "manifest-display-url",
        output_type: "display_data",
        data: {
          "image/png": { url: "http://127.0.0.1:9876/blob/pnghash" },
        },
      }),
    ).toBe(true);
  });

  it("returns true for an execute_result manifest", () => {
    expect(
      isOutputManifest({
        output_id: "manifest-execute-inline",
        output_type: "execute_result",
        data: { "text/plain": { inline: "42" } },
        execution_count: 1,
      }),
    ).toBe(true);
  });

  it("returns true for an error manifest with inline traceback", () => {
    expect(
      isOutputManifest({
        output_id: "manifest-error-inline",
        output_type: "error",
        ename: "ValueError",
        evalue: "bad",
        traceback: { inline: '["line1"]' },
      }),
    ).toBe(true);
  });

  it("returns false for a raw JupyterOutput (stream with string text)", () => {
    expect(
      isOutputManifest({
        output_type: "stream",
        name: "stdout",
        text: "hello\n",
      }),
    ).toBe(false);
  });

  it("returns false for a raw JupyterOutput (display_data with string data)", () => {
    expect(
      isOutputManifest({
        output_type: "display_data",
        data: { "text/plain": "hi" },
        metadata: {},
      }),
    ).toBe(false);
  });

  it("returns false for null", () => {
    expect(isOutputManifest(null)).toBe(false);
  });

  it("returns false for manifests without output_id", () => {
    expect(
      isOutputManifest({
        output_type: "stream",
        name: "stdout",
        text: { inline: "hello\n" },
      }),
    ).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isOutputManifest("hello")).toBe(false);
  });

  it("returns false for an object without output_type", () => {
    expect(isOutputManifest({ data: { "text/plain": { inline: "x" } } })).toBe(
      false,
    );
  });

  it("returns false for display_data with empty data", () => {
    expect(
      isOutputManifest({
        output_id: "manifest-empty-display",
        output_type: "display_data",
        data: {},
      }),
    ).toBe(false);
  });

  it("returns false for unknown output_type", () => {
    expect(
      isOutputManifest({
        output_id: "manifest-unknown-type",
        output_type: "unknown_type",
        data: {},
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveManifestSync
// ---------------------------------------------------------------------------

describe("resolveManifestSync", () => {
  const blobPort = 8765;

  it("resolves stream manifest with inline text", () => {
    const manifest: OutputManifest = {
      output_id: "sync-stream-inline",
      output_type: "stream",
      name: "stdout",
      text: { inline: "hello\n" },
    };
    const output = resolveManifestSync(manifest, blobPort);
    expect(output).toEqual({
      output_id: "sync-stream-inline",
      output_type: "stream",
      name: "stdout",
      text: "hello\n",
    });
  });

  it("returns null for stream manifest with blob text ref", () => {
    const manifest: OutputManifest = {
      output_id: "sync-stream-blob",
      output_type: "stream",
      name: "stdout",
      text: { blob: "abc123", size: 100 },
    };
    expect(resolveManifestSync(manifest, blobPort)).toBeNull();
  });

  it("resolves display_data with all inline refs", () => {
    const manifest: OutputManifest = {
      output_id: "sync-display-inline",
      output_type: "display_data",
      data: {
        "text/plain": { inline: "hi" },
        "text/html": { inline: "<b>hi</b>" },
      },
      metadata: { isolated: true },
      transient: { display_id: "d1" },
    };
    const output = resolveManifestSync(manifest, blobPort);
    expect(output).toEqual({
      output_id: "sync-display-inline",
      output_type: "display_data",
      data: { "text/plain": "hi", "text/html": "<b>hi</b>" },
      metadata: { isolated: true },
      display_id: "d1",
    });
  });

  it("resolves display_data with url ref", () => {
    const manifest: OutputManifest = {
      output_id: "sync-display-url",
      output_type: "display_data",
      data: {
        "image/png": { url: `http://127.0.0.1:${blobPort}/blob/imgblob` },
      },
    };
    const output = resolveManifestSync(manifest, blobPort);
    expect(output).toEqual({
      output_id: "sync-display-url",
      output_type: "display_data",
      data: { "image/png": `http://127.0.0.1:${blobPort}/blob/imgblob` },
      metadata: {},
      display_id: undefined,
    });
  });

  it("returns null for display_data with text blob ref", () => {
    const manifest: OutputManifest = {
      output_id: "sync-display-blob",
      output_type: "display_data",
      data: {
        "text/plain": { blob: "textblob", size: 5000 },
      },
    };
    expect(resolveManifestSync(manifest, blobPort)).toBeNull();
  });

  it("resolves error manifest with inline traceback", () => {
    const traceback = ["line1", "line2"];
    const manifest: OutputManifest = {
      output_id: "sync-error-inline",
      output_type: "error",
      ename: "ValueError",
      evalue: "bad",
      traceback: { inline: JSON.stringify(traceback) },
    };
    const output = resolveManifestSync(manifest, blobPort);
    expect(output).toEqual({
      output_id: "sync-error-inline",
      output_type: "error",
      ename: "ValueError",
      evalue: "bad",
      traceback,
    });
  });

  it("returns null for error manifest with blob traceback", () => {
    const manifest: OutputManifest = {
      output_id: "sync-error-blob",
      output_type: "error",
      ename: "ValueError",
      evalue: "bad",
      traceback: { blob: "tbblob", size: 2000 },
    };
    expect(resolveManifestSync(manifest, blobPort)).toBeNull();
  });

  it("resolves error manifest with inline rich sibling", () => {
    // Launcher-emitted rich payload: small enough to live inline on the
    // manifest. Sync resolve should attach the parsed payload to the output.
    const richPayload = { ename: "KeyError", evalue: "'x'", frames: [], text: "KeyError: 'x'" };
    const manifest: OutputManifest = {
      output_id: "sync-error-rich-inline",
      output_type: "error",
      ename: "KeyError",
      evalue: "'x'",
      traceback: { inline: JSON.stringify(["KeyError: 'x'"]) },
      rich: { inline: JSON.stringify(richPayload) },
    };
    const output = resolveManifestSync(manifest, blobPort);
    expect(output).not.toBeNull();
    if (output && output.output_type === "error") {
      expect(output.rich).toEqual(richPayload);
    }
  });

  it("defers sync resolution when rich is blob-backed", () => {
    // Classic traceback is inline (would normally be sync-resolvable),
    // but the rich sibling exceeds the 1KB threshold and lives in a blob.
    // Without deferring, callers would accept the sync result as final
    // and the rich payload would never be fetched — rich tracebacks of
    // any size would downgrade to ANSI rendering.
    const manifest: OutputManifest = {
      output_id: "sync-error-rich-blob",
      output_type: "error",
      ename: "ZeroDivisionError",
      evalue: "division by zero",
      traceback: { inline: JSON.stringify(["ZeroDivisionError: division by zero"]) },
      rich: { blob: "richblob", size: 4096 },
    };
    expect(resolveManifestSync(manifest, blobPort)).toBeNull();
  });

  it("omits rich field when absent on the manifest", () => {
    // Classic path with no rich sibling (e.g. vanilla ipykernel_launcher
    // whose ANSI traceback didn't parse into frames). rich stays
    // undefined so OutputArea falls through to AnsiErrorOutput.
    const manifest: OutputManifest = {
      output_id: "sync-error-no-rich",
      output_type: "error",
      ename: "ValueError",
      evalue: "bad",
      traceback: { inline: JSON.stringify(["ValueError: bad"]) },
    };
    const output = resolveManifestSync(manifest, blobPort);
    expect(output).not.toBeNull();
    if (output && output.output_type === "error") {
      expect(output.rich).toBeUndefined();
    }
  });

  it("auto-parses JSON MIME types in sync resolution", () => {
    const manifest: OutputManifest = {
      output_id: "sync-json",
      output_type: "execute_result",
      data: {
        "application/json": { inline: '{"key":"value"}' },
        "text/plain": { inline: "{'key': 'value'}" },
      },
      execution_count: 1,
    };
    const output = resolveManifestSync(manifest, blobPort);
    expect(output).not.toBeNull();
    if (output && output.output_type === "execute_result") {
      expect(output.data["application/json"]).toEqual({ key: "value" });
      expect(output.data["text/plain"]).toBe("{'key': 'value'}");
    }
  });

  it("adds blob URLs to Arrow stream manifest chunks in sync resolution", () => {
    const manifest: OutputManifest = {
      output_id: "sync-arrow-display",
      output_type: "display_data",
      data: {
        [ARROW_STREAM_MANIFEST_MIME]: {
          inline: JSON.stringify({
            version: 1,
            content_type: "application/vnd.apache.arrow.stream",
            chunks: [{ index: 0, hash: "arrowhash", size: 128, row_count: 3 }],
            complete: true,
          }),
        },
        "application/vnd.apache.arrow.stream": {
          url: `http://127.0.0.1:${blobPort}/blob/arrowhash`,
        },
      },
    };
    const output = resolveManifestSync(manifest, blobPort);
    expect(output).not.toBeNull();
    if (output && output.output_type === "display_data") {
      expect(output.data[ARROW_STREAM_MANIFEST_MIME]).toMatchObject({
        chunks: [
          {
            hash: "arrowhash",
            url: `http://127.0.0.1:${blobPort}/blob/arrowhash`,
          },
        ],
      });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveContentRef
// ---------------------------------------------------------------------------

describe("resolveContentRef", () => {
  const blobPort = 9876;

  it("returns inline content immediately without fetching", async () => {
    const ref: ContentRef = { inline: "hello world" };
    const result = await resolveContentRef(ref, blobPort);
    expect(result).toBe("hello world");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty string for inline empty content", async () => {
    const ref: ContentRef = { inline: "" };
    const result = await resolveContentRef(ref, blobPort);
    expect(result).toBe("");
  });

  it("returns url ref directly without fetching", async () => {
    const ref: ContentRef = { url: "http://127.0.0.1:9876/blob/pnghash" };
    const result = await resolveContentRef(ref, blobPort);
    expect(result).toBe("http://127.0.0.1:9876/blob/pnghash");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches text blob content from the blob store", async () => {
    const blobHash = "abc123";
    const ref: ContentRef = { blob: blobHash, size: 42 };

    mockFetch.mockResolvedValueOnce(
      new Response("fetched content", { status: 200 }),
    );

    const result = await resolveContentRef(ref, blobPort, "text/plain");
    expect(result).toBe("fetched content");
    expect(mockFetch).toHaveBeenCalledWith(
      `http://127.0.0.1:${blobPort}/blob/${blobHash}`,
    );
  });

  it("fetches blob content when no mimeType is provided", async () => {
    const ref: ContentRef = { blob: "hash123", size: 5 };
    mockFetch.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await resolveContentRef(ref, blobPort);
    expect(result).toBe("ok");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("throws on non-OK response from blob store", async () => {
    const ref: ContentRef = { blob: "deadbeef", size: 10 };

    mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(
      resolveContentRef(ref, blobPort, "text/plain"),
    ).rejects.toThrow("Failed to fetch blob deadbeef: 404");
  });

  it("uses the correct port in blob fetch URL", async () => {
    const ref: ContentRef = { blob: "hash123", size: 5 };
    mockFetch.mockResolvedValueOnce(new Response("data", { status: 200 }));

    const result = await resolveContentRef(ref, 5555);
    expect(result).toBe("data");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5555/blob/hash123",
    );
  });

  it("uses resolver URLs and fetch policy without a daemon port", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("cloud", { status: 200 }));
    const resolver = createBlobResolver({
      url: (ref) => `/api/n/notebook-1/blobs/${encodeURIComponent(ref.blob)}`,
      fetchImpl,
      requestInit: { credentials: "include" },
    });

    const result = await resolveContentRef(
      { blob: "sha256:abc", size: 5 },
      resolver,
      "text/plain",
    );

    expect(result).toBe("cloud");
    expect(fetchImpl).toHaveBeenCalledWith("/api/n/notebook-1/blobs/sha256%3Aabc", {
      credentials: "include",
    });
  });

  it.each([
    ["application/vnd.apache.arrow.stream", "sha256:arrow"],
    ["application/vnd.apache.parquet", "sha256:parquet"],
  ])("resolves %s blob refs through the host URL resolver", async (mimeType, blob) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("should not fetch", { status: 200 }));
    const resolver = createBlobResolver({
      url: (ref) => `https://assets.example.test/blobs/${encodeURIComponent(ref.blob)}`,
      fetchImpl,
    });

    const result = await resolveContentRef({ blob, size: 128 }, resolver, mimeType);

    expect(result).toBe(`https://assets.example.test/blobs/${encodeURIComponent(blob)}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveDataBundle
// ---------------------------------------------------------------------------

describe("resolveDataBundle", () => {
  const blobPort = 9876;

  it("resolves inline content refs to their values", async () => {
    const data: Record<string, ContentRef> = {
      "text/plain": { inline: "hello" },
      "text/html": { inline: "<b>hello</b>" },
    };

    const result = await resolveDataBundle(data, blobPort);
    expect(result).toEqual({
      "text/plain": "hello",
      "text/html": "<b>hello</b>",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("auto-parses JSON MIME types", async () => {
    const jsonObj = { key: "value", nested: { a: 1 } };
    const data: Record<string, ContentRef> = {
      "application/json": { inline: JSON.stringify(jsonObj) },
    };

    const result = await resolveDataBundle(data, blobPort);
    expect(result["application/json"]).toEqual(jsonObj);
  });

  it("auto-parses vnd+json MIME types", async () => {
    const vegaSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    };
    const data: Record<string, ContentRef> = {
      "application/vnd.vegalite.v5+json": { inline: JSON.stringify(vegaSpec) },
    };

    const result = await resolveDataBundle(data, blobPort);
    expect(result["application/vnd.vegalite.v5+json"]).toEqual(vegaSpec);
  });

  it("adds blob URLs to Arrow stream manifest chunks", async () => {
    const data: Record<string, ContentRef> = {
      [ARROW_STREAM_MANIFEST_MIME]: {
        inline: JSON.stringify({
          version: 1,
          content_type: "application/vnd.apache.arrow.stream",
          chunks: [{ index: 0, hash: "chunkhash", size: 256, row_count: 4 }],
          complete: true,
        }),
      },
    };

    const result = await resolveDataBundle(data, blobPort);
    expect(result[ARROW_STREAM_MANIFEST_MIME]).toMatchObject({
      chunks: [
        {
          hash: "chunkhash",
          url: `http://127.0.0.1:${blobPort}/blob/chunkhash`,
        },
      ],
    });
  });

  it("keeps direct Arrow and Parquet blob refs as host-owned URLs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("should not fetch", { status: 200 }));
    const resolver = createBlobResolver({
      url: (ref) => `https://assets.example.test/blobs/${encodeURIComponent(ref.blob)}`,
      fetchImpl,
    });

    const result = await resolveDataBundle(
      {
        "application/vnd.apache.arrow.stream": { blob: "sha256:arrow", size: 1024 },
        "application/vnd.apache.parquet": { blob: "sha256:parquet", size: 2048 },
        "text/plain": { inline: "shape: (25, 10)" },
      },
      resolver,
    );

    expect(result["application/vnd.apache.arrow.stream"]).toBe(
      "https://assets.example.test/blobs/sha256%3Aarrow",
    );
    expect(result["application/vnd.apache.parquet"]).toBe(
      "https://assets.example.test/blobs/sha256%3Aparquet",
    );
    expect(result["text/plain"]).toBe("shape: (25, 10)");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to raw string for invalid JSON in json MIME type", async () => {
    const data: Record<string, ContentRef> = {
      "application/json": { inline: "not valid json{" },
    };

    const result = await resolveDataBundle(data, blobPort);
    expect(result["application/json"]).toBe("not valid json{");
  });

  it("does not parse non-JSON MIME types", async () => {
    const jsonString = '{"key":"value"}';
    const data: Record<string, ContentRef> = {
      "text/plain": { inline: jsonString },
    };

    const result = await resolveDataBundle(data, blobPort);
    expect(result["text/plain"]).toBe(jsonString);
  });

  it("resolves url refs without fetching", async () => {
    const data: Record<string, ContentRef> = {
      "image/png": { url: "http://127.0.0.1:9876/blob/pnghash" },
    };

    const result = await resolveDataBundle(data, blobPort);
    expect(result["image/png"]).toBe("http://127.0.0.1:9876/blob/pnghash");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles mixed inline text and url refs", async () => {
    const data: Record<string, ContentRef> = {
      "text/plain": { inline: "fallback text" },
      "image/png": { url: "http://127.0.0.1:9876/blob/pnghash" },
    };

    const result = await resolveDataBundle(data, blobPort);
    expect(result["text/plain"]).toBe("fallback text");
    expect(result["image/png"]).toBe("http://127.0.0.1:9876/blob/pnghash");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles empty data bundle", async () => {
    const result = await resolveDataBundle({}, blobPort);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// resolveManifest
// ---------------------------------------------------------------------------

describe("resolveManifest", () => {
  const blobPort = 9876;

  describe("display_data manifests", () => {
    it("resolves inline data refs", async () => {
      const manifest: OutputManifest = {
        output_id: "async-display-inline",
        output_type: "display_data",
        data: {
          "text/plain": { inline: "hello" },
          "text/html": { inline: "<b>hello</b>" },
        },
        metadata: { isolated: true },
        transient: { display_id: "d1" },
      };

      const output = await resolveManifest(manifest, blobPort);
      expect(output).toEqual({
        output_id: "async-display-inline",
        output_type: "display_data",
        data: {
          "text/plain": "hello",
          "text/html": "<b>hello</b>",
        },
        metadata: { isolated: true },
        display_id: "d1",
      });
    });

    it("defaults metadata to empty object when omitted", async () => {
      const manifest: OutputManifest = {
        output_id: "async-display-metadata-default",
        output_type: "display_data",
        data: { "text/plain": { inline: "hi" } },
      };

      const output = await resolveManifest(manifest, blobPort);
      expect(output).toEqual({
        output_id: "async-display-metadata-default",
        output_type: "display_data",
        data: { "text/plain": "hi" },
        metadata: {},
        display_id: undefined,
      });
    });

    it("resolves url refs directly", async () => {
      const manifest: OutputManifest = {
        output_id: "async-display-url",
        output_type: "display_data",
        data: {
          "image/png": { url: "http://127.0.0.1:9876/blob/pnghash" },
        },
      };

      const output = await resolveManifest(manifest, blobPort);
      expect(output).toEqual({
        output_id: "async-display-url",
        output_type: "display_data",
        data: { "image/png": "http://127.0.0.1:9876/blob/pnghash" },
        metadata: {},
        display_id: undefined,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("execute_result manifests", () => {
    it("resolves with execution_count", async () => {
      const manifest: OutputManifest = {
        output_id: "async-execute-count",
        output_type: "execute_result",
        data: { "text/plain": { inline: "42" } },
        execution_count: 5,
      };

      const output = await resolveManifest(manifest, blobPort);
      expect(output).toEqual({
        output_id: "async-execute-count",
        output_type: "execute_result",
        data: { "text/plain": "42" },
        metadata: {},
        execution_count: 5,
        display_id: undefined,
      });
    });

    it("defaults execution_count to null when omitted", async () => {
      const manifest: OutputManifest = {
        output_id: "async-execute-count-default",
        output_type: "execute_result",
        data: { "text/plain": { inline: "result" } },
      };

      const output = await resolveManifest(manifest, blobPort);
      if (output.output_type === "execute_result") {
        expect(output.execution_count).toBeNull();
      }
    });

    it("preserves transient display_id", async () => {
      const manifest: OutputManifest = {
        output_id: "async-execute-display-id",
        output_type: "execute_result",
        data: { "text/plain": { inline: "x" } },
        transient: { display_id: "exec-d1" },
      };

      const output = await resolveManifest(manifest, blobPort);
      if (
        output.output_type === "execute_result" ||
        output.output_type === "display_data"
      ) {
        expect(output.display_id).toBe("exec-d1");
      }
    });

    it("auto-parses JSON MIME types in data", async () => {
      const manifest: OutputManifest = {
        output_id: "async-execute-json",
        output_type: "execute_result",
        data: {
          "application/json": { inline: '{"answer":42}' },
          "text/plain": { inline: "{'answer': 42}" },
        },
        execution_count: 1,
      };

      const output = await resolveManifest(manifest, blobPort);
      if (output.output_type === "execute_result") {
        expect(output.data["application/json"]).toEqual({ answer: 42 });
        expect(output.data["text/plain"]).toBe("{'answer': 42}");
      }
    });
  });

  describe("stream manifests", () => {
    it("resolves inline text", async () => {
      const manifest: OutputManifest = {
        output_id: "async-stream-inline",
        output_type: "stream",
        name: "stdout",
        text: { inline: "hello world\n" },
      };

      const output = await resolveManifest(manifest, blobPort);
      expect(output).toEqual({
        output_id: "async-stream-inline",
        output_type: "stream",
        name: "stdout",
        text: "hello world\n",
      });
    });

    it("resolves blob text", async () => {
      const manifest: OutputManifest = {
        output_id: "async-stream-blob",
        output_type: "stream",
        name: "stderr",
        text: { blob: "errhash", size: 100 },
      };

      mockFetch.mockResolvedValueOnce(
        new Response("error output text", { status: 200 }),
      );

      const output = await resolveManifest(manifest, blobPort);
      expect(output).toEqual({
        output_id: "async-stream-blob",
        output_type: "stream",
        name: "stderr",
        text: "error output text",
      });
    });
  });

  describe("error manifests", () => {
    it("resolves traceback from inline ref", async () => {
      const traceback = ["frame1", "frame2", "frame3"];
      const manifest: OutputManifest = {
        output_id: "async-error-inline",
        output_type: "error",
        ename: "ValueError",
        evalue: "invalid literal",
        traceback: { inline: JSON.stringify(traceback) },
      };

      const output = await resolveManifest(manifest, blobPort);
      expect(output).toEqual({
        output_id: "async-error-inline",
        output_type: "error",
        ename: "ValueError",
        evalue: "invalid literal",
        traceback: ["frame1", "frame2", "frame3"],
      });
    });

    it("resolves traceback from blob ref", async () => {
      const traceback = ["Traceback (most recent call last):", "  File ..."];
      const manifest: OutputManifest = {
        output_id: "async-error-blob",
        output_type: "error",
        ename: "RuntimeError",
        evalue: "boom",
        traceback: { blob: "tbhash", size: 200 },
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(traceback), { status: 200 }),
      );

      const output = await resolveManifest(manifest, blobPort);
      expect(output).toEqual({
        output_id: "async-error-blob",
        output_type: "error",
        ename: "RuntimeError",
        evalue: "boom",
        traceback,
      });
    });

    it("preserves ename and evalue verbatim", async () => {
      const manifest: OutputManifest = {
        output_id: "async-error-verbatim",
        output_type: "error",
        ename: "Custom.Error.Name",
        evalue: "message with 'quotes' and \"doubles\"",
        traceback: { inline: "[]" },
      };

      const output = await resolveManifest(manifest, blobPort);
      if (output.output_type === "error") {
        expect(output.ename).toBe("Custom.Error.Name");
        expect(output.evalue).toBe("message with 'quotes' and \"doubles\"");
      }
    });
  });
});
