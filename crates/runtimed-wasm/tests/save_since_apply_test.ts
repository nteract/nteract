/**
 * Deno tests for the chunked-persistence / tab-bridge WASM exports:
 * `save_since_heads()` and `apply_change_bytes()` through the real built
 * bindings (not the Rust inner functions).
 *
 * Run with:
 *   deno test --allow-read --allow-env --no-check crates/runtimed-wasm/tests/
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadRuntimedWasm } from "./wasm_loader.ts";

// @ts-nocheck — wasm-bindgen output doesn't have Deno-compatible type declarations

// deno-lint-ignore no-explicit-any
const { NotebookHandle }: any = await loadRuntimedWasm();

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

Deno.test("save_since_heads: empty basis is a full save; tail loads concatenated", () => {
  const author = new NotebookHandle("chunks-deno");
  author.set_actor("user:dev:test/browser:a");
  author.add_cell(0, "cell-1", "code");
  author.update_source("cell-1", "x = 1");

  const snapshot = author.save_since_heads([]);
  assert(snapshot.byteLength > 0, "empty basis yields the full save");
  const basis = author.get_heads_hex();

  author.add_cell(1, "cell-2", "markdown");
  author.update_source("cell-2", "# title");
  const incremental = author.save_since_heads(basis);
  assert(incremental.byteLength > 0, "tail changes serialize");
  assert(incremental.byteLength < snapshot.byteLength, "tail is smaller than the snapshot");
  assertEquals(author.save_since_heads(author.get_heads_hex()).byteLength, 0);

  const loaded = NotebookHandle.load(concat(snapshot, incremental));
  assertEquals(loaded.cell_count(), 2);
  assertEquals(loaded.get_cell_source("cell-2"), "# title");

  loaded.free();
  author.free();
});

Deno.test("apply_change_bytes: sync_applied shape, then changed=false on known changes", () => {
  const author = new NotebookHandle("bridge-deno");
  author.set_actor("user:dev:test/browser:a");
  author.add_cell(0, "cell-1", "code");
  author.update_source("cell-1", "x = 1");
  const bytes = author.save_since_heads([]);

  const peer = NotebookHandle.create_bootstrap("user:dev:test/browser:b");
  const first = peer.apply_change_bytes(bytes);
  assertEquals(first.type, "sync_applied");
  assertEquals(first.changed, true);
  assertEquals(first.reply, undefined, "apply path never carries a sync reply");
  assert(first.changeset.added.includes("cell-1"), "changeset surfaces the added cell");
  assertEquals(peer.cell_count(), 1);
  assertEquals(peer.get_cell_source("cell-1"), "x = 1");

  // Two-tab ping-pong pin: re-applying known changes must report
  // changed=false with no changeset (nothing to re-trigger a broadcast).
  const second = peer.apply_change_bytes(bytes);
  assertEquals(second.type, "sync_applied");
  assertEquals(second.changed, false);
  assertEquals(second.changeset, undefined);

  peer.free();
  author.free();
});
