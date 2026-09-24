import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { firstValueFrom } from "rxjs";
import { connectCloudSyncRuntime, type CloudWebSocketTransport } from "../viewer/live-sync.ts";
import {
  _resetRuntimedWasmClientForTests,
  _setRuntimedWasmModuleImporterForTests,
} from "../viewer/runtimed-wasm-client.ts";

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
  _resetRuntimedWasmClientForTests();
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

test("initializes engine assets while the room handshake is still pending", async () => {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("https://example.test/n/probe"),
  });
  let started = false;
  _setRuntimedWasmModuleImporterForTests(async () => {
    started = true;
    throw new Error("invalid WASM module");
  });
  let transport: CloudWebSocketTransport | undefined;
  let rejectTarget!: (error: Error) => void;
  const connected = connectCloudSyncRuntime({
    connectTarget: () =>
      new Promise((_resolve, reject) => {
        rejectTarget = reject;
      }),
    runtimedWasmModulePath: "/assets/runtimed_wasm.js",
    runtimedWasmPath: "/assets/runtimed_wasm_bg.wasm",
    onTransportCreated: (value) => {
      transport = value;
    },
  });
  // Register a handler before yielding; both branches must have owned errors.
  const failed = assert.rejects(connected, /invalid WASM module/);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, true, "WASM must start before the room grants a peer id");
    await failed;
    assert.ok(transport);
    assert.equal(await firstValueFrom(transport.connectionStatus$), "offline");
  } finally {
    transport?.disconnect();
    rejectTarget(new Error("cancelled probe"));
    await failed;
  }
});
