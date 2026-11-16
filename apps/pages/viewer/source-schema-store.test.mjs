import assert from "node:assert/strict";
import test from "node:test";
import { BehaviorSubject } from "rxjs";
import { initialSchema, schemaTransition, sourceSchemaStore } from "./source-schema-store.mjs";

const version = { asset_id: "a", revision: "1", media_type: "application/vnd.apache.parquet" };
const summary = { rows: 300, column_count: 5, columns: [{ name: "account_id", type: "Int32" }] };

test("schema transitions fence the host summary by the selected immutable asset", () => {
  const loading = schemaTransition(initialSchema, { type: "load", version });
  const loaded = { type: "loaded", assetId: "a", source: { asset_id: "a", summary } };
  const ready = schemaTransition(loading, loaded);
  assert.equal(ready.name, "ready");
  assert.equal(ready.summary, summary);
  for (const state of [ready, { name: "unavailable" }, { name: "failed" }]) {
    assert.equal(schemaTransition(state, loaded), state);
    assert.equal(schemaTransition(state, { type: "failed", assetId: "a" }), state);
    assert.equal(schemaTransition(state, { type: "load", version }).name, "loading");
    assert.equal(schemaTransition(state, { type: "missing" }).name, "unavailable");
  }
  assert.equal(schemaTransition(loading, { ...loaded, assetId: "old" }), loading);
  assert.equal(
    schemaTransition(loading, { ...loaded, source: { asset_id: "new", summary } }).name,
    "unavailable",
  );
  assert.equal(
    schemaTransition(loading, { ...loaded, source: { asset_id: "a", summary: null } }).name,
    "unavailable",
  );
  assert.equal(
    schemaTransition(loading, { type: "failed", assetId: "a", message: "Offline" }).message,
    "Offline",
  );
});

test("source refresh and unmount abort schema reads; late results cannot replace the current schema", async () => {
  const versions = new BehaviorSubject({ accounts: version });
  const calls = [];
  const read = (operation, args, { signal }) =>
    new Promise((resolve) => {
      calls.push({ operation, args, signal, resolve });
    });
  const resource = sourceSchemaStore(
    { pageId: "page", pageSources: { versions: () => versions } },
    "accounts",
    read,
  );
  const stop = resource.start();
  assert.deepEqual(calls[0].args, { page_id: "page", source_id: "accounts" });
  versions.next({ accounts: { ...version, asset_id: "b", revision: "2" } });
  assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve({ source: { asset_id: "b", summary } });
  await Promise.resolve();
  assert.equal(resource.store.snapshot().version.revision, "2");
  assert.equal(resource.store.snapshot().name, "ready");
  calls[0].resolve({ source: { asset_id: "a", summary: { rows: 1 } } });
  await Promise.resolve();
  assert.equal(resource.store.snapshot().summary.rows, 300);
  versions.next({ accounts: { ...version, asset_id: "c", revision: "3" } });
  stop();
  assert.equal(calls[2].signal.aborted, true);
  assert.equal(versions.observers.length, 0);
});
