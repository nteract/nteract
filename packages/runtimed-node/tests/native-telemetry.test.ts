// @vitest-environment node
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import type { OpenTelemetryRegistrationOptions, TelemetryRegistration } from "../src/index";

const require = createRequire(import.meta.url);
const nativeEnabled = process.env.RUNTIMED_NODE_NATIVE_INTEGRATION === "1";

describe.skipIf(!nativeEnabled)("native host telemetry registration", () => {
  let rt: typeof import("../src/index");
  let directory: string;
  let socketPath: string;
  let server: net.Server;
  let sockets: Set<net.Socket>;
  let requests: Array<Record<string, unknown>>;
  let capability: boolean | undefined;
  let emissionEnabled: boolean | undefined;
  let onRequest: (request: Record<string, unknown>, socket: net.Socket) => void;

  function reply(socket: net.Socket, response: Record<string, unknown>) {
    const body = Buffer.from(JSON.stringify(response));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length);
    socket.write(Buffer.concat([prefix, body]));
  }

  beforeEach(async () => {
    rt = require("../src/index.cjs");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "runt-tel-"));
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${path.basename(directory)}`
        : path.join(directory, "daemon.sock");
    sockets = new Set();
    requests = [];
    capability = true;
    emissionEnabled = false;
    onRequest = (_request, socket) => reply(socket, { type: "host_telemetry_ack" });
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      let buffer = Buffer.alloc(0);
      let preamble = true;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (preamble) {
          if (buffer.length < 5) return;
          expect([...buffer.subarray(0, 4)]).toEqual([0xc0, 0xde, 0x01, 0xac]);
          buffer = buffer.subarray(5);
          preamble = false;
        }
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (buffer.length < 4 + length) return;
          const request = JSON.parse(buffer.subarray(4, 4 + length).toString());
          buffer = buffer.subarray(4 + length);
          if (request.channel === "pool") continue;
          requests.push(request);
          if (request.type === "get_daemon_info") {
            reply(socket, {
              type: "daemon_info",
              host_telemetry: capability,
              host_telemetry_enabled: emissionEnabled,
              protocol_version: 4,
              daemon_api_version: 1,
              daemon_version: "0.5.6+fixture",
              pid: 42,
              started_at: "2026-09-29T00:00:00Z",
            });
          } else {
            onRequest(request, socket);
          }
        }
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(["app", "mcp"] as const)(
    "defaults %s permission to denied and acknowledges updates and close",
    async (source) => {
      const options: OpenTelemetryRegistrationOptions = { socketPath, hostId: "test-host", source };
      expectTypeOf(options).toEqualTypeOf<
        import("../src/binding").OpenTelemetryRegistrationOptions
      >();
      const registration = await rt.openTelemetryRegistration(options);
      expectTypeOf(registration).toEqualTypeOf<TelemetryRegistration | null>();
      expect(registration).not.toBeNull();
      if (!registration) throw new Error("registration unsupported");
      try {
        expect(requests).toEqual([
          { type: "get_daemon_info" },
          { type: "register_host_telemetry", host_id: "test-host", source, allowed: false },
        ]);
        await registration.updatePermission(true);
        await registration.updatePermission(false);
        await registration.close();
        await registration.close();
        expect(requests.slice(2)).toEqual([
          { type: "update_host_telemetry_permission", allowed: true },
          { type: "update_host_telemetry_permission", allowed: false },
          { type: "close_host_telemetry" },
        ]);
        await expect(registration.updatePermission(true)).rejects.toThrow();
      } finally {
        await registration.close();
      }
    },
  );

  it("waits for remote revocation acknowledgment before resolving close", async () => {
    const registration = await rt.openTelemetryRegistration({
      socketPath,
      hostId: "test-host",
      source: "app",
      allowed: true,
    });
    if (!registration) throw new Error("registration unsupported");
    expect(requests[1].allowed).toBe(true);
    let closeSocket: net.Socket | undefined;
    onRequest = (request, socket) => {
      expect(request.type).toBe("close_host_telemetry");
      closeSocket = socket;
    };
    let closed = false;
    const closing = registration.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(closeSocket).toBeDefined());
    expect(closed).toBe(false);
    reply(closeSocket!, { type: "host_telemetry_ack" });
    await closing;
    expect(closed).toBe(true);
  });

  it.each([undefined, false])(
    "returns null without registration when capability is %s",
    async (supported) => {
      capability = supported;
      await expect(
        rt.openTelemetryRegistration({ socketPath, hostId: "test-host", source: "app" }),
      ).resolves.toBeNull();
      expect(requests).toEqual([{ type: "get_daemon_info" }]);
    },
  );

  it("synchronously fences a queued grant before close returns its Promise", async () => {
    const registration = await rt.openTelemetryRegistration({
      socketPath,
      hostId: "test-host",
      source: "app",
    });
    if (!registration) throw new Error("registration unsupported");
    let observedUpdate!: (socket: net.Socket) => void;
    const updateSeen = new Promise<net.Socket>((resolve) => {
      observedUpdate = resolve;
    });
    let observedClose!: (socket: net.Socket) => void;
    const closeSeen = new Promise<net.Socket>((resolve) => {
      observedClose = resolve;
    });
    onRequest = (request, socket) => {
      if (request.type === "close_host_telemetry") {
        observedClose(socket);
      } else {
        expect(request).toEqual({ type: "update_host_telemetry_permission", allowed: false });
        observedUpdate(socket);
      }
    };

    // An observed request with no ACK keeps the Rust serial actor inside its RPC.
    const blockingUpdate = registration.updatePermission(false);
    const socket = await updateSeen;
    const grant = registration.updatePermission(true);
    const rejectedGrant = expect(grant).rejects.toThrow();
    let closed = false;
    const closePromise = registration.close();
    expectTypeOf(closePromise).toEqualTypeOf<Promise<void>>();
    expectTypeOf(closePromise).toEqualTypeOf<
      ReturnType<import("../src/binding").TelemetryRegistration["close"]>
    >();
    expect(closePromise).toBeInstanceOf(Promise);
    const closing = closePromise.then(() => {
      closed = true;
    });
    // No yield: close must set the fence before the blocked actor can resume.
    reply(socket, { type: "host_telemetry_ack" });
    await blockingUpdate;
    const closingSocket = await closeSeen;
    await rejectedGrant;
    expect(closed).toBe(false);
    expect(requests.slice(2)).toEqual([
      { type: "update_host_telemetry_permission", allowed: false },
      { type: "close_host_telemetry" },
    ]);
    reply(closingSocket, { type: "host_telemetry_ack" });
    await closing;
    expect(closed).toBe(true);
    await registration.close();
  });

  it.each(["daemon", "APP", "", "x".repeat(10000)])(
    "rejects invalid sources before connecting (%#)",
    async (source) => {
      await expect(
        // @ts-expect-error public declarations restrict the source to app | mcp
        rt.openTelemetryRegistration({ socketPath, hostId: "test-host", source }),
      ).rejects.toThrow('source must be "app" or "mcp"');
      expect(requests).toEqual([]);
    },
  );

  it("rejects disconnected updates and close without re-registering", async () => {
    const registration = await rt.openTelemetryRegistration({
      socketPath,
      hostId: "test-host",
      source: "app",
    });
    if (!registration) throw new Error("registration unsupported");
    onRequest = (_request, socket) => socket.destroy();
    await expect(registration.updatePermission(false)).rejects.toThrow();
    await expect(registration.close()).rejects.toThrow();
    await expect(registration.updatePermission(true)).rejects.toThrow();
    expect(requests.filter((request) => request.type === "register_host_telemetry")).toHaveLength(
      1,
    );
  });

  it.each(["error", "unexpected", "eof", "timeout"])(
    "rejects close without a revocation acknowledgment (%s)",
    async (failure) => {
      const registration = await rt.openTelemetryRegistration({
        socketPath,
        hostId: "test-host",
        source: "app",
      });
      if (!registration) throw new Error("registration unsupported");
      onRequest = (request, socket) => {
        expect(request.type).toBe("close_host_telemetry");
        if (failure === "error") reply(socket, { type: "error", message: "revocation failed" });
        if (failure === "unexpected") reply(socket, { type: "shutting_down" });
        if (failure === "eof") socket.end();
      };
      await expect(registration.close()).rejects.toThrow();
      await expect(registration.close()).rejects.toThrow();
      await expect(registration.updatePermission(true)).rejects.toThrow();
      expect(requests.filter((request) => request.type === "close_host_telemetry")).toHaveLength(1);
    },
    10000,
  );

  it.each(["", "unknown", "UPPER", "host_name", "a".repeat(65)])(
    "rejects invalid host IDs before connecting (%#)",
    async (hostId) => {
      await expect(
        rt.openTelemetryRegistration({ socketPath, hostId, source: "app" }),
      ).rejects.toThrow("invalid host_id");
      expect(requests).toEqual([]);
    },
  );

  it.each([
    [true, false],
    [true, true],
    [undefined, undefined],
  ])("maps protocol %s and emission %s metadata separately", async (supported, enabled) => {
    capability = supported;
    emissionEnabled = enabled;
    const info = await rt.queryDaemonInfo({ socketPath });
    expect(info?.hostTelemetry).toBe(supported ?? false);
    expect(info?.hostTelemetryEnabled).toBe(enabled ?? false);
    expect(info).not.toHaveProperty("host_telemetry");
    expect(info).not.toHaveProperty("host_telemetry_enabled");
  });
});
