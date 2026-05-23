import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/index.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  DurableObjectNamespace,
  Env,
  ExecutionContext,
  R2Bucket,
  R2HTTPMetadata,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from "../src/cloudflare-types.ts";
import { initializeRuntimedWasm } from "../src/runtimed-wasm.ts";
import { blobKey, renderKey, snapshotKey } from "../src/storage.ts";

const wasmBytes = await readFile(
  new URL("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", import.meta.url),
);

before(async () => {
  await initializeRuntimedWasm(wasmBytes);
});

describe("Worker artifact routes", () => {
  it("serves viewer bundle assets through the Worker assets binding", async () => {
    const env = fakeEnv({
      ASSETS: {
        fetch: async () =>
          new Response("console.log('viewer')", {
            headers: { "Content-Type": "application/javascript" },
          }),
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/assets/notebook-cloud-viewer.js"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(await response.text(), "console.log('viewer')");
  });

  it("adds CORS when plugin assets are routed through the Worker", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("wasm", {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/plugins/sift_wasm.wasm?v=test"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/plugins/sift_wasm.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
    assert.equal(await response.text(), "wasm");
  });

  it("serves renderer sidecar assets through a Worker-owned route", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("wasm", {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/renderer-assets/sift_wasm.wasm?v=test"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/plugins/sift_wasm.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
  });

  it("supports HEAD requests for Worker-owned renderer sidecars", async () => {
    const seenRequests: Array<{ method: string; pathname: string }> = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenRequests.push({
            method: request.method,
            pathname: new URL(request.url).pathname,
          });
          return new Response(null, {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/renderer-assets/sift_wasm.wasm?v=test", { method: "HEAD" }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenRequests, [{ method: "HEAD", pathname: "/plugins/sift_wasm.wasm" }]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
  });

  it("rejects non-read asset requests before the assets binding", async () => {
    const env = fakeEnv({
      ASSETS: {
        fetch: async () => new Response("should not be reached"),
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/renderer-assets/sift_wasm.wasm", { method: "POST" }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.deepEqual(await response.json(), { error: "method not allowed" });
  });

  it("rejects traversal-shaped renderer sidecar aliases before asset lookup", async () => {
    const requests = [
      "http://localhost/renderer-assets/%2e%2e%2fassets%2fnotebook-cloud-viewer.js",
      "http://localhost/renderer-assets/nested/sift_wasm.wasm",
      "http://localhost/plugins/%2e%2e%5csift_wasm.wasm",
      "http://localhost/api/plugins/nested/sift_wasm.wasm",
    ];

    for (const request of requests) {
      const env = fakeEnv({
        ASSETS: {
          fetch: async () => new Response("should not be reached"),
        },
      });

      const response = await worker.fetch(new Request(request), env, fakeContext());

      assert.equal(response.status, 404, request);
      assert.deepEqual(await response.json(), { error: "not found" }, request);
    }
  });

  it("keeps the api plugin path as a compatibility alias for older viewers", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("wasm", {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/plugins/sift_wasm.wasm?v=test"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/plugins/sift_wasm.wasm"]);
  });

  it("does not expose prototype room event observability", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/events"),
      env,
      fakeContext(),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
  });

  it("keeps anonymous viewer requests read-only on publish and upload routes", async () => {
    const env = fakeEnv({ DEPLOYMENT_ENV: "prototype" });
    const body = new TextEncoder().encode("viewer cannot write this");
    const routes = [
      {
        pathname: "/api/n/readonly-demo/runtime-snapshots/runtime-viewer",
        error: "viewer cannot publish runtime snapshots",
      },
      {
        pathname: "/api/n/readonly-demo/snapshots/heads-viewer",
        error: "viewer cannot publish snapshots",
      },
      {
        pathname: "/api/n/readonly-demo/blobs/sha256-viewer",
        error: "viewer cannot upload blobs",
      },
    ];

    for (const route of routes) {
      const response = await worker.fetch(
        new Request(
          new URL(`${route.pathname}?scope=owner&viewer_session=anon`, "https://cloud.test"),
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body,
          },
        ),
        env,
        fakeContext(),
      );

      assert.equal(response.status, 403, route.pathname);
      assert.deepEqual(await response.json(), { error: route.error });
    }

    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.size, 0);
    assert.equal(env.DB.revisions.length, 0);
  });

  it("keeps render caches derived from snapshot pairs instead of accepting uploads", async () => {
    const env = fakeEnv();
    const response = await ownerPut(
      env,
      "/api/n/readonly-demo/renders/heads-viewer",
      new TextEncoder().encode(JSON.stringify({ cells: [] })),
      {
        "Content-Type": "application/json",
      },
    );

    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: "method not allowed" });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.size, 0);
    assert.equal(env.DB.notebooks.size, 0);
  });

  it("keeps explicit dev viewer scope read-only even with a valid dev token", async () => {
    const env = fakeEnv({
      DEPLOYMENT_ENV: "prototype",
      NOTEBOOK_CLOUD_DEV_TOKEN: "secret-token",
    });
    const response = await worker.fetch(
      new Request("https://cloud.test/api/n/readonly-demo/blobs/sha256-viewer", {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Notebook-Cloud-Dev-Token": "secret-token",
          "X-Operator": "desktop:test",
          "X-Scope": "viewer",
          "X-User": "alice",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "viewer cannot upload blobs" });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.size, 0);
  });

  it("allows runtime peers to upload content-addressed output blobs", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-demo");
    const body = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(body);

    const response = await scopedPut(env, `/api/n/runtime-demo/blobs/${hash}`, body, {
      "Content-Type": "application/vnd.apache.arrow.stream",
      "X-Scope": "runtime_peer",
      "X-User": "runtime-service",
      "X-Operator": "runtime:py-3.12",
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      ok: true,
      key: blobKey("runtime-demo", hash),
      size: body.byteLength,
    });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.has(blobKey("runtime-demo", hash)), true);
    assert.deepEqual(env.DB.blobs.get(`runtime-demo:${hash}`), {
      notebook_id: "runtime-demo",
      hash,
      size: body.byteLength,
      content_type: "application/vnd.apache.arrow.stream",
      r2_key: blobKey("runtime-demo", hash),
      uploaded_at: env.DB.blobs.get(`runtime-demo:${hash}`)?.uploaded_at,
    });
  });

  it("rejects blob uploads whose path hash does not match the bytes", async () => {
    const env = fakeEnv();
    const body = new Uint8Array([1, 2, 3, 4]);
    const actual = await sha256Hex(body);
    const expected = "0".repeat(64);

    const response = await scopedPut(env, `/api/n/runtime-demo/blobs/${expected}`, body, {
      "X-Scope": "runtime_peer",
      "X-User": "runtime-service",
      "X-Operator": "runtime:py-3.12",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "blob hash mismatch",
      expected,
      actual,
    });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.has(blobKey("runtime-demo", expected)), false);
    assert.equal(env.DB.blobs.size, 0);
    assert.equal(env.DB.notebooks.has("runtime-demo"), false);
  });

  it("publishes a snapshot pair and materializes render JSON through the route layer", async () => {
    const env = fakeEnv();
    const [notebookBytes, runtimeStateBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/output_streaming/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/output_streaming/state_doc.bin",
          import.meta.url,
        ),
      ),
    ]);

    const runtimePut = await ownerPut(
      env,
      "/api/n/route-demo/runtime-snapshots/runtime-fixture",
      runtimeStateBytes,
    );
    assert.equal(runtimePut.status, 201);

    const notebookPut = await ownerPut(
      env,
      "/api/n/route-demo/snapshots/heads-fixture",
      notebookBytes,
      {
        "X-Runtime-Heads-Hash": "runtime-fixture",
      },
    );
    assert.equal(notebookPut.status, 201);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(renderKey("route-demo", "heads-fixture")),
      true,
      "snapshot publish should pre-materialize a render cache for complete snapshot pairs",
    );

    const response = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/render"),
      env,
      fakeContext(),
    );
    assert.equal(response.status, 200);
    const render = (await response.json()) as {
      source: string;
      cells: Array<{ id: string; outputs: Array<{ output_id: string }> }>;
    };

    assert.equal(render.source, "snapshot-pair");
    assert.equal(render.cells[0].id, "cell-1");
    assert.deepEqual(
      render.cells[0].outputs.map((output) => output.output_id),
      [
        "c8b09c2d-a456-5186-b875-441a5fadf374",
        "58af4526-9a90-5bca-98de-d8d0e36718b2",
        "cad63e3f-42e3-542b-b28b-5d3acde7906d",
      ],
    );
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(renderKey("route-demo", "heads-fixture")),
      true,
      "materialized render should be cached back into R2",
    );
  });

  it("rejects snapshot publish when the referenced runtime snapshot is missing", async () => {
    const env = fakeEnv();
    const notebookBytes = await readFile(
      new URL(
        "../../../packages/runtimed/tests/fixtures/output_streaming/doc.bin",
        import.meta.url,
      ),
    );

    const response = await ownerPut(
      env,
      "/api/n/missing-runtime-demo/snapshots/heads-fixture",
      notebookBytes,
      {
        "X-Runtime-Heads-Hash": "runtime-missing",
      },
    );

    assert.equal(response.status, 424);
    const body = (await response.json()) as { error: string; runtime_heads_hash: string };
    assert.equal(body.error, "snapshot publish missing runtime-state snapshot");
    assert.equal(body.runtime_heads_hash, "runtime-missing");
    assert.equal(env.DB.revisions.length, 0);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(snapshotKey("missing-runtime-demo", "heads-fixture")),
      false,
      "rejected snapshot publish should not leave an orphan notebook snapshot",
    );
  });

  it("rejects snapshot publish when the persisted pair cannot be materialized", async () => {
    const env = fakeEnv();
    const corruptBytes = new TextEncoder().encode("not an automerge document");

    const runtimePut = await ownerPut(
      env,
      "/api/n/corrupt-demo/runtime-snapshots/runtime-corrupt",
      corruptBytes,
    );
    assert.equal(runtimePut.status, 201);

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let response: Response;
    try {
      response = await ownerPut(env, "/api/n/corrupt-demo/snapshots/heads-corrupt", corruptBytes, {
        "X-Runtime-Heads-Hash": "runtime-corrupt",
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(response.status, 422);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (await response.json()) as { error: string; details: string };
    assert.equal(body.error, "render materialization failed");
    assert.match(body.details, /load|document|decode|automerge/i);
    assert.equal(env.DB.revisions.length, 0);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(snapshotKey("corrupt-demo", "heads-corrupt")),
      false,
      "rejected snapshot publish should not leave a corrupt notebook snapshot",
    );
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(renderKey("corrupt-demo", "heads-corrupt")),
      false,
      "failed publish materialization should not cache a render object",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "Unable to materialize notebook render");
  });

  it("rejects snapshot publish when materialized blob refs are missing from R2", async () => {
    const env = fakeEnv();
    const [notebookBytes, runtimeStateBytes, manifestBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/state_doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    const manifest = JSON.parse(manifestBytes) as { blobs: Array<{ hash: string }> };
    const missingHash = manifest.blobs[0]?.hash;
    assert.equal(typeof missingHash, "string");

    const runtimePut = await ownerPut(
      env,
      "/api/n/missing-blob-demo/runtime-snapshots/runtime-fixture",
      runtimeStateBytes,
    );
    assert.equal(runtimePut.status, 201);

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let response: Response;
    try {
      response = await ownerPut(
        env,
        "/api/n/missing-blob-demo/snapshots/heads-fixture",
        notebookBytes,
        {
          "X-Runtime-Heads-Hash": "runtime-fixture",
        },
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(response.status, 424);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (await response.json()) as {
      error: string;
      missing_blobs: Array<{ hash: string }>;
    };
    assert.equal(body.error, "render materialization missing blobs");
    assert.ok(
      body.missing_blobs.some((blob) => blob.hash === missingHash),
      "response should include the missing fixture blob hash",
    );
    assert.equal(env.DB.revisions.length, 0);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(snapshotKey("missing-blob-demo", "heads-fixture")),
      false,
      "rejected snapshot publish should not leave an orphan notebook snapshot",
    );
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(renderKey("missing-blob-demo", "heads-fixture")),
      false,
      "failed blob validation should not cache a render object",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "Unable to materialize notebook render: missing blobs");
  });
});

async function ownerPut(
  env: FakeEnv,
  pathname: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return scopedPut(env, pathname, body, {
    "X-Scope": "owner",
    ...headers,
  });
}

async function scopedPut(
  env: FakeEnv,
  pathname: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(new URL(pathname, "http://localhost"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-User": "alice",
        "X-Operator": "desktop:test",
        ...headers,
      },
      body,
    }),
    env,
    fakeContext(),
  );
}

function seedNotebook(env: FakeEnv, notebookId: string): void {
  env.DB.notebooks.set(notebookId, {
    id: notebookId,
    owner_principal: "user:dev:alice",
    title: null,
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    latest_revision_id: null,
  });
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface FakeEnv extends Env {
  DB: FakeD1;
  NOTEBOOK_SNAPSHOTS: FakeR2Bucket;
}

function fakeEnv(overrides: Partial<Env> = {}): FakeEnv {
  const env: FakeEnv = {
    DEPLOYMENT_ENV: "development",
    DB: new FakeD1(),
    NOTEBOOK_SNAPSHOTS: new FakeR2Bucket(),
    NOTEBOOK_ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response("not implemented", { status: 501 }),
      }),
    } satisfies DurableObjectNamespace,
  };
  Object.assign(env, overrides);
  return env;
}

function fakeContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}

interface NotebookRow {
  id: string;
  owner_principal: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  latest_revision_id: string | null;
}

interface RevisionRow {
  id: string;
  notebook_id: string;
  notebook_heads_hash: string;
  runtime_heads_hash: string | null;
  snapshot_key: string;
  runtime_snapshot_key: string | null;
  actor_label: string;
  created_at: string;
}

class FakeD1 implements D1Database {
  readonly notebooks = new Map<string, NotebookRow>();
  readonly revisions: RevisionRow[] = [];
  readonly blobs = new Map<string, BlobRow>();

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this, query);
  }

  async exec(): Promise<D1Result> {
    return okResult();
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.run<T>());
    }
    return results;
  }
}

class FakeD1Statement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes("INSERT INTO notebooks")) {
      const [id, ownerPrincipal, updatedAt] = this.values as [string, string, string];
      const existing = this.db.notebooks.get(id);
      this.db.notebooks.set(id, {
        id,
        owner_principal: existing?.owner_principal ?? ownerPrincipal,
        title: existing?.title ?? null,
        created_at: existing?.created_at ?? updatedAt,
        updated_at: updatedAt,
        latest_revision_id: existing?.latest_revision_id ?? null,
      });
    } else if (this.query.includes("INSERT INTO notebook_revisions")) {
      const [
        id,
        notebookId,
        notebookHeadsHash,
        runtimeHeadsHash,
        snapshotKey,
        runtimeSnapshotKey,
        actorLabel,
      ] = this.values as [string, string, string, string | null, string, string | null, string];
      this.db.revisions.push({
        id,
        notebook_id: notebookId,
        notebook_heads_hash: notebookHeadsHash,
        runtime_heads_hash: runtimeHeadsHash,
        snapshot_key: snapshotKey,
        runtime_snapshot_key: runtimeSnapshotKey,
        actor_label: actorLabel,
        created_at: new Date().toISOString(),
      });
    } else if (this.query.includes("UPDATE notebooks")) {
      const [revisionId, updatedAt, notebookId] = this.values as [string, string, string];
      const existing = this.db.notebooks.get(notebookId);
      if (existing) {
        existing.latest_revision_id = revisionId;
        existing.updated_at = updatedAt;
      }
    } else if (this.query.includes("INSERT INTO notebook_blobs")) {
      const [notebookId, hash, size, contentType, r2Key] = this.values as [
        string,
        string,
        number,
        string | null,
        string,
      ];
      this.db.blobs.set(`${notebookId}:${hash}`, {
        notebook_id: notebookId,
        hash,
        size,
        content_type: contentType,
        r2_key: r2Key,
        uploaded_at: new Date().toISOString(),
      });
    }
    return okResult();
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM notebooks")) {
      return (this.db.notebooks.get(this.values[0] as string) as T | undefined) ?? null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes("FROM notebook_revisions")) {
      const notebookId = this.values[0] as string;
      return okResult(
        this.db.revisions.filter((revision) => revision.notebook_id === notebookId) as T[],
      );
    }
    if (this.query.includes("FROM notebook_blobs")) {
      const notebookId = this.values[0] as string;
      return okResult(
        Array.from(this.db.blobs.values()).filter((blob) => blob.notebook_id === notebookId) as T[],
      );
    }
    return okResult([]);
  }
}

interface BlobRow {
  notebook_id: string;
  hash: string;
  size: number;
  content_type: string | null;
  r2_key: string;
  uploaded_at: string;
}

function okResult<T = unknown>(results?: T[]): D1Result<T> {
  return {
    results,
    success: true,
    meta: {},
  };
}

class FakeR2Bucket implements R2Bucket {
  readonly objects = new Map<string, FakeR2Object>();

  async get(key: string): Promise<R2ObjectBody | null> {
    return this.objects.get(key) ?? null;
  }

  async head(key: string): Promise<R2Object | null> {
    return this.objects.get(key) ?? null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const object = new FakeR2Object(key, await toBytes(value), options?.httpMetadata);
    this.objects.set(key, object);
    return object;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeR2Object implements R2ObjectBody {
  readonly version = "fake-version";
  readonly etag = "fake-etag";
  readonly httpEtag = '"fake-etag"';
  readonly uploaded = new Date("2026-05-22T00:00:00.000Z");
  readonly customMetadata = {};

  constructor(
    readonly key: string,
    private readonly bytes: Uint8Array,
    readonly httpMetadata?: R2HTTPMetadata,
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  get body(): ReadableStream {
    return new Response(this.bytes).body!;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength,
    );
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata?.contentType) {
      headers.set("Content-Type", this.httpMetadata.contentType);
    }
  }
}

async function toBytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
): Promise<Uint8Array> {
  if (value === null) {
    return new Uint8Array();
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}
