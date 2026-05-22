/**
 * Presence CBOR smoke tests for runtimed-wasm.
 *
 * Run with:
 *   deno test --allow-read crates/runtimed-wasm/tests/presence_test.ts
 */

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// @ts-nocheck - wasm-bindgen output is browser-shaped, but Deno can run it.

const wasmJsPath = new URL(
  "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBinPath = new URL(
  "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

const mod = await import(wasmJsPath.href);
const wasmBytes = await Deno.readFile(wasmBinPath);
await mod.default(wasmBytes);

Deno.test("Presence: standalone decoder reads real cursor CBOR", () => {
  const payload = mod.encode_cursor_presence(
    "client-peer",
    "Alice",
    "user:dev:alice/desktop:browser",
    "cell-1",
    2,
    4,
  );

  const decoded = mod.decode_presence_frame(payload);

  assertEquals(decoded, {
    type: "update",
    peer_id: "client-peer",
    peer_label: "Alice",
    actor_label: "user:dev:alice/desktop:browser",
    channel: "cursor",
    data: {
      cell_id: "cell-1",
      line: 2,
      column: 4,
    },
  });
});

Deno.test("Presence: generic JS object encoder round-trips through CBOR", () => {
  const message = {
    type: "update",
    peer_id: "client-peer",
    peer_label: "Alice",
    actor_label: "user:dev:alice/desktop:browser",
    channel: "selection",
    data: {
      cell_id: "cell-1",
      anchor_line: 1,
      anchor_col: 2,
      head_line: 3,
      head_col: 4,
    },
  };

  const encoded = mod.encode_presence_frame(message);

  assertEquals(mod.decode_presence_frame(encoded), message);
});

Deno.test("Presence: ingress rewrite stamps trusted peer and principal", () => {
  const payload = mod.encode_cursor_presence(
    "client-forged-peer",
    "Mallory",
    "user:dev:mallory/agent:codex:s1",
    "cell-2",
    5,
    7,
  );

  const rewritten = mod.rewrite_presence_ingress(
    payload,
    "server-peer",
    "Alice",
    "user:dev:alice",
    "desktop:browser",
  );

  assertEquals(mod.decode_presence_frame(rewritten), {
    type: "update",
    peer_id: "server-peer",
    peer_label: "Alice",
    actor_label: "user:dev:alice/agent:codex:s1",
    channel: "cursor",
    data: {
      cell_id: "cell-2",
      line: 5,
      column: 7,
    },
  });
});

Deno.test("Presence: ingress rewrite falls back for malformed actor labels", () => {
  const payload = mod.encode_presence_frame({
    type: "update",
    peer_id: "client-peer",
    actor_label: "bad/principal/extra",
    channel: "focus",
    data: { cell_id: "cell-3" },
  });

  const rewritten = mod.rewrite_presence_ingress(
    payload,
    "server-peer",
    "",
    "user:dev:alice",
    "desktop:fallback",
  );

  assertEquals(mod.decode_presence_frame(rewritten), {
    type: "update",
    peer_id: "server-peer",
    actor_label: "user:dev:alice/desktop:fallback",
    channel: "focus",
    data: { cell_id: "cell-3" },
  });
});

Deno.test("Presence: ingress rewrite restamps heartbeat peer id", () => {
  const payload = mod.encode_heartbeat_presence("client-peer");
  const rewritten = mod.rewrite_presence_ingress(
    payload,
    "server-peer",
    "",
    "user:dev:alice",
    "desktop:browser",
  );

  assertEquals(mod.decode_presence_frame(rewritten), {
    type: "heartbeat",
    peer_id: "server-peer",
  });
});

Deno.test("Presence: ingress rewrite restamps clear-channel peer id", () => {
  const payload = mod.encode_presence_frame({
    type: "clear_channel",
    peer_id: "client-forged-peer",
    channel: "cursor",
  });
  const rewritten = mod.rewrite_presence_ingress(
    payload,
    "server-peer",
    "",
    "user:dev:alice",
    "desktop:browser",
  );

  assertEquals(mod.decode_presence_frame(rewritten), {
    type: "clear_channel",
    peer_id: "server-peer",
    channel: "cursor",
  });
});

Deno.test("Presence: ingress rewrite restamps left peer id", () => {
  const payload = mod.encode_presence_frame({
    type: "left",
    peer_id: "client-forged-peer",
  });
  const rewritten = mod.rewrite_presence_ingress(
    payload,
    "server-peer",
    "",
    "user:dev:alice",
    "desktop:browser",
  );

  assertEquals(mod.decode_presence_frame(rewritten), {
    type: "left",
    peer_id: "server-peer",
  });
});

Deno.test("Presence: ingress rewrite rejects client snapshots", () => {
  const payload = mod.encode_presence_frame({
    type: "snapshot",
    peer_id: "client-peer",
    peers: [],
  });

  assertThrows(
    () =>
      mod.rewrite_presence_ingress(
        payload,
        "server-peer",
        "",
        "user:dev:alice",
        "desktop:browser",
      ),
    Error,
    "snapshots",
  );
});

Deno.test("Presence: ingress rewrite rejects client kernel-state updates", () => {
  const payload = mod.encode_presence_frame({
    type: "update",
    peer_id: "client-peer",
    channel: "kernel_state",
    data: {
      status: "idle",
      env_source: "python",
    },
  });

  assertThrows(
    () =>
      mod.rewrite_presence_ingress(
        payload,
        "server-peer",
        "",
        "user:dev:alice",
        "desktop:browser",
      ),
    Error,
    "kernel state",
  );
});
