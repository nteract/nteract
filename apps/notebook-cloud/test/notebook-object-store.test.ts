import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { R2Bucket, R2Object, R2ObjectBody } from "../src/cloudflare-types.ts";
import { notebookObjectStore, R2NotebookObjectStore } from "../src/notebook-object-store.ts";
import {
  S3NotebookObjectStore,
  s3NotebookObjectStoreConfigFromEnv,
} from "../src/s3-notebook-object-store.ts";

describe("notebook object stores", () => {
  it("preserves the existing R2 behavior through the portable adapter", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2NotebookObjectStore(bucket);

    await store.put("snapshots/notebook.am", "notebook", {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { notebook_id: "notebook-1" },
    });

    assert.equal(await (await store.get("snapshots/notebook.am"))?.text(), "notebook");
    assert.equal(
      (await store.head("snapshots/notebook.am"))?.customMetadata?.notebook_id,
      "notebook-1",
    );
    assert.equal(
      notebookObjectStore({ NOTEBOOK_SNAPSHOTS: bucket }) instanceof R2NotebookObjectStore,
      true,
    );
  });

  it("prefers an injected host-neutral store over the Cloudflare binding", () => {
    const injected = new R2NotebookObjectStore(new FakeR2Bucket());
    const resolved = notebookObjectStore({
      NOTEBOOK_OBJECT_STORE: injected,
      NOTEBOOK_SNAPSHOTS: new FakeR2Bucket(),
    });

    assert.equal(resolved, injected);
  });

  it("maps keys and metadata onto an S3-compatible client", async () => {
    const client = new FakeS3Client();
    const store = new S3NotebookObjectStore(client, {
      bucket: "customer-notebooks",
      region: "us-west-2",
      prefix: "/documents/prototype/",
      endpoint: "https://objects.example.test",
      forcePathStyle: true,
    });

    await store.put("blobs/abc", "payload", {
      httpMetadata: {
        contentType: "application/vnd.apache.arrow.stream",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { notebook_id: "notebook-1", hash: "abc" },
    });

    assert.equal(client.lastKey, "documents/prototype/blobs/abc");
    const head = await store.head("blobs/abc");
    assert.equal(head?.size, 7);
    assert.equal(head?.etag, "fake-etag");
    assert.equal(head?.httpEtag, '"fake-etag"');
    assert.equal(head?.httpMetadata?.contentType, "application/vnd.apache.arrow.stream");
    assert.equal(head?.customMetadata?.notebook_id, "notebook-1");

    const body = await store.get("blobs/abc");
    assert.equal(await body?.text(), "payload");

    await store.delete("blobs/abc");
    assert.equal(await store.head("blobs/abc"), null);
  });

  it("rejects empty and parent-traversing object keys", async () => {
    const store = new S3NotebookObjectStore(new FakeS3Client(), {
      bucket: "customer-notebooks",
      region: "us-west-2",
    });

    await assert.rejects(store.head("/../secret"), /Invalid notebook object key/);
    await assert.rejects(store.get("  "), /Invalid notebook object key/);
  });

  it("loads portable S3 settings without defining a credential format", () => {
    assert.deepEqual(
      s3NotebookObjectStoreConfigFromEnv({
        NOTEBOOK_CLOUD_S3_BUCKET: " customer-notebooks ",
        NOTEBOOK_CLOUD_S3_REGION: "us-west-2",
        NOTEBOOK_CLOUD_S3_ENDPOINT: "https://objects.example.test",
        NOTEBOOK_CLOUD_S3_PREFIX: "notebooks/experiment",
        NOTEBOOK_CLOUD_S3_FORCE_PATH_STYLE: "true",
      }),
      {
        bucket: "customer-notebooks",
        region: "us-west-2",
        endpoint: "https://objects.example.test",
        prefix: "notebooks/experiment",
        forcePathStyle: true,
      },
    );
    assert.throws(
      () =>
        s3NotebookObjectStoreConfigFromEnv({
          NOTEBOOK_CLOUD_S3_BUCKET: "customer-notebooks",
          NOTEBOOK_CLOUD_S3_REGION: "us-west-2",
          NOTEBOOK_CLOUD_S3_FORCE_PATH_STYLE: "sometimes",
        }),
      /must be true or false/,
    );
  });
});

class FakeR2Bucket implements R2Bucket {
  private readonly objects = new Map<string, FakeR2Object>();

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    return object ? object.body() : null;
  }

  async head(key: string): Promise<R2Object | null> {
    return this.objects.get(key)?.head() ?? null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2Object> {
    const bytes = new Uint8Array(await new Response(value as BodyInit | null).arrayBuffer());
    const object = new FakeR2Object(key, bytes, options);
    this.objects.set(key, object);
    return object.head();
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeR2Object {
  constructor(
    private readonly key: string,
    private readonly bytes: Uint8Array,
    private readonly options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ) {}

  head(): R2Object {
    const options = this.options;
    return {
      key: this.key,
      version: "fake-version",
      size: this.bytes.byteLength,
      etag: "fake-etag",
      httpEtag: '"fake-etag"',
      uploaded: new Date("2026-08-20T00:00:00.000Z"),
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      writeHttpMetadata(headers: Headers) {
        if (options?.httpMetadata?.contentType) {
          headers.set("Content-Type", options.httpMetadata.contentType);
        }
      },
    };
  }

  body(): R2ObjectBody {
    const bytes = this.bytes;
    return {
      ...this.head(),
      body: new Response(bytes).body!,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      async text() {
        return new TextDecoder().decode(bytes);
      },
    };
  }
}

interface StoredS3Object {
  bytes: Uint8Array;
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

class FakeS3Client {
  readonly objects = new Map<string, StoredS3Object>();
  lastKey: string | undefined;

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const key = String(command.input.Key);
      this.lastKey = key;
      const bytes = new Uint8Array(
        await new Response(command.input.Body as BodyInit | null).arrayBuffer(),
      );
      this.objects.set(key, {
        bytes,
        contentType: command.input.ContentType,
        cacheControl: command.input.CacheControl,
        metadata: command.input.Metadata,
      });
      return { ETag: '"fake-etag"' };
    }
    if (command instanceof HeadObjectCommand) {
      const object = this.objectOrThrow(String(command.input.Key));
      return this.metadata(object);
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objectOrThrow(String(command.input.Key));
      return {
        ...this.metadata(object),
        Body: {
          transformToWebStream: () => new Response(object.bytes).body!,
        },
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(String(command.input.Key));
      return {};
    }
    throw new Error("Unexpected S3 command");
  }

  private objectOrThrow(key: string): StoredS3Object {
    const object = this.objects.get(key);
    if (!object) {
      throw Object.assign(new Error("not found"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
    }
    return object;
  }

  private metadata(object: StoredS3Object): Record<string, unknown> {
    return {
      VersionId: "fake-version",
      ContentLength: object.bytes.byteLength,
      ETag: '"fake-etag"',
      LastModified: new Date("2026-08-20T00:00:00.000Z"),
      ContentType: object.contentType,
      CacheControl: object.cacheControl,
      Metadata: object.metadata,
    };
  }
}
