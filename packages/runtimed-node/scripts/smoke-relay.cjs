#!/usr/bin/env node
/**
 * Daemon-backed smoke test for the native typed-frame relay.
 *
 * Build the N-API binding, start a compatible daemon, then run:
 *
 *   RUNTIMED_SOCKET_PATH=/path/to/runtimed.sock \
 *   pnpm --dir packages/runtimed-node smoke:relay
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createRelay } = require("../src/relay.cjs");

async function main() {
  const socketPath = process.env.RUNTIMED_SOCKET_PATH;
  assert(socketPath, "RUNTIMED_SOCKET_PATH must point to a running compatible daemon");

  const relay = await createRelay({
    socketPath,
    runtime: "python",
    workingDir: process.cwd(),
    ephemeral: true,
    description: "@runtimed/node relay smoke",
  });

  try {
    const seenTypes = [];
    const requestId = crypto.randomUUID();
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`relay response timed out; frame types: ${seenTypes.join(",")}`)),
        10_000,
      );
      relay.onFrame((frame) => {
        assert(Buffer.isBuffer(frame), "relay delivers Node Buffers");
        seenTypes.push(frame[0]);
        if (frame[0] !== 0x02) return;
        const envelope = JSON.parse(frame.subarray(1).toString("utf8"));
        if (envelope.id !== requestId) return;
        clearTimeout(timeout);
        resolve(envelope);
      });
    });

    const payload = Buffer.from(JSON.stringify({ id: requestId, action: "get_doc_bytes" }));
    await relay.send(Buffer.concat([Buffer.from([0x01]), payload]));
    const envelope = await response;

    assert.equal(relay.info.protocolVersion, 4, "relay negotiated protocol v4");
    assert(seenTypes.includes(0x00), "relay received an Automerge sync frame");
    assert(seenTypes.includes(0x05), "relay received a runtime-state sync frame");
    assert(
      Array.isArray(envelope.bytes) && envelope.bytes.length > 0,
      "daemon returned notebook document bytes",
    );
    await assert.rejects(relay.send(Buffer.from([0x07])), /SessionControl/);

    const closed = new Promise((resolve) => relay.onClose(resolve));
    await relay.close();
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("relay close notification timed out")), 2_000),
      ),
    ]);

    console.log(
      JSON.stringify({
        ok: true,
        notebookId: relay.notebookId,
        protocolVersion: relay.info.protocolVersion,
        frameTypes: [...new Set(seenTypes)].sort(),
      }),
    );
  } finally {
    await relay.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
