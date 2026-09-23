import { createNotebookWithOwnerAcl } from "../src/storage.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { storeManagedPythonBlob } from "../src/managed-python-blobs.ts";
import { normalizedBlobUploadContentType } from "../src/blob-content-type.ts";

test("managed blobs normalize metadata, retain first writer and heal catalog entries", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const objects = new Map();
    let writes = 0;
    const env = {
      DB: {
        async batch(statements) {
          return Promise.all(statements.map((s) => s.run()));
        },
        prepare(sql) {
          let values = [];
          return {
            bind(...args) {
              values = args;
              return this;
            },
            async run() {
              sqlite.prepare(sql).run(...values);
              return { success: true, meta: {} };
            },
            async all() {
              return { success: true, results: sqlite.prepare(sql).all(...values) };
            },
            async first() {
              return sqlite.prepare(sql).get(...values) ?? null;
            },
          };
        },
      },
      NOTEBOOK_SNAPSHOTS: {
        head: async (key) => objects.get(key) ?? null,
        put: async (key, bytes, options) => {
          assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" });
          if (objects.has(key)) return null;
          writes++;
          const stored = { size: bytes.length, ...options };
          objects.set(key, stored);
          return stored;
        },
      },
    };
    for (const id of ["notebook", "other"])
      await createNotebookWithOwnerAcl(env, id, {
        principal: "alice",
        actorLabel: "alice/browser",
        scope: "owner",
      });
    const bytes = new TextEncoder().encode("<html/>");
    await storeManagedPythonBlob(env, "notebook", {
      hash: "hash",
      bytes,
      mediaType: "application/xhtml+xml",
    });
    assert.equal(writes, 1);
    const first = [...objects.values()][0];
    assert.equal(first.httpMetadata.contentType, "application/octet-stream");
    assert.equal(first.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
    assert.deepEqual(first.customMetadata, { notebook_id: "notebook", hash: "hash" });
    sqlite.exec("DELETE FROM notebook_blobs");
    await storeManagedPythonBlob(env, "notebook", { hash: "hash", bytes, mediaType: "text/html" });
    assert.equal(writes, 1);
    assert.equal(
      sqlite.prepare("SELECT content_type FROM notebook_blobs").get().content_type,
      "application/octet-stream",
    );
    await storeManagedPythonBlob(env, "other", {
      hash: "hash",
      bytes,
      mediaType: " IMAGE/PNG ; extra=value",
    });
    assert.equal(writes, 2);
    assert.equal(
      sqlite.prepare("SELECT content_type FROM notebook_blobs WHERE notebook_id='other'").get()
        .content_type,
      "image/png",
    );
    assert.equal(normalizedBlobUploadContentType("application/xml"), null);
    const previousWrites = writes;
    await Promise.all([
      storeManagedPythonBlob(env, "notebook", {
        hash: "concurrent",
        bytes,
        mediaType: "text/plain",
      }),
      storeManagedPythonBlob(env, "notebook", {
        hash: "concurrent",
        bytes,
        mediaType: "text/html",
      }),
    ]);
    assert.equal(writes, previousWrites + 1, "the conditional write admits exactly one writer");
    assert.equal(
      sqlite.prepare("SELECT content_type FROM notebook_blobs WHERE hash='concurrent'").get()
        .content_type,
      "text/plain",
    );
  } finally {
    sqlite.close();
  }
});
