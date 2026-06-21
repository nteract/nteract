// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { createBrowserHost } from "../src/browser";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  sent: Array<Uint8Array> = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  message(data: unknown) {
    this.onmessage?.({ data });
  }
}

const config = {
  websocket_url: "ws://127.0.0.1:5174/__nteract_dev_relay/ws",
  token: "dev-token",
  blob_port: 48123,
  daemon: {
    version: "dev",
    socket_path: "/tmp/runtimed.sock",
    is_dev_mode: true,
  },
};

function fetchConfig() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => config,
  })) as unknown as typeof fetch;
}

function textFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(1 + payload.length);
  frame[0] = 0x02;
  frame.set(payload, 1);
  return frame;
}

describe("createBrowserHost()", () => {
  it("connects to the dev relay with a token and emits ready", async () => {
    FakeWebSocket.instances = [];
    const host = await createBrowserHost({
      fetchImpl: fetchConfig(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain("token=dev-token");

    const ready = vi.fn();
    host.daemonEvents.onReady(ready);
    ws.open();
    ws.message(
      JSON.stringify({
        type: "ready",
        payload: {
          notebook_id: "nb-1",
          cell_count: 0,
          ephemeral: true,
          comments_doc_id: "comments:local-room:nb-1",
          comments_notebook_ref: { kind: "local_room", room_id: "nb-1" },
        },
        blob_port: 48124,
        daemon: config.daemon,
      }),
    );

    expect(ready).toHaveBeenCalledWith({
      notebook_id: "nb-1",
      cell_count: 0,
      ephemeral: true,
      comments_doc_id: "comments:local-room:nb-1",
      comments_notebook_ref: { kind: "local_room", room_id: "nb-1" },
    });
    await expect(host.blobs.port()).resolves.toBe(48124);
    await expect(host.blobs.resolver()).resolves.toMatchObject({ port: 48124 });
    expect((await host.blobs.resolver()).url({ blob: "abc123" })).toBe(
      "http://127.0.0.1:48124/blob/abc123",
    );
    await expect(host.daemon.getReadyInfo()).resolves.toMatchObject({ notebook_id: "nb-1" });
  });

  it("buffers daemon frames until the relay is marked ready", async () => {
    FakeWebSocket.instances = [];
    const host = await createBrowserHost({
      fetchImpl: fetchConfig(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const frameListener = vi.fn();
    host.transport.onFrame(frameListener);
    ws.message(new Uint8Array([0x00, 1, 2, 3]).buffer);
    expect(frameListener).not.toHaveBeenCalled();

    await host.relay.notifySyncReady();
    expect(frameListener).toHaveBeenCalledWith([0x00, 1, 2, 3]);
  });

  it("sends notebook requests as request frames and resolves response frames", async () => {
    FakeWebSocket.instances = [];
    const host = await createBrowserHost({
      fetchImpl: fetchConfig(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const result = host.transport.sendRequest({ type: "get_history", query: "import" });
    await Promise.resolve();
    const sent = ws.sent[0];
    expect(sent[0]).toBe(0x01);
    const request = JSON.parse(new TextDecoder().decode(sent.slice(1))) as {
      id: string;
      action: string;
      query: string;
    };
    expect(request).toMatchObject({ action: "get_history", query: "import" });

    ws.message(
      textFrame({
        id: request.id,
        result: "ok",
        entries: [],
      }).buffer,
    );
    await expect(result).resolves.toEqual({ result: "ok", entries: [] });
  });

  it("keeps browser synced settings in memory and notifies subscribers", async () => {
    FakeWebSocket.instances = [];
    const host = await createBrowserHost({
      fetchImpl: fetchConfig(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const changed = vi.fn();
    const unlisten = host.settings.onChanged(changed);

    await expect(host.settings.getSynced()).resolves.toEqual({});
    await host.settings.setSynced("theme", "dark");
    await expect(host.settings.getSynced()).resolves.toEqual({ theme: "dark" });
    expect(changed).toHaveBeenCalledWith({ theme: "dark" });

    await host.settings.setSynced("uv.default_packages", ["numpy", "pandas"]);
    await expect(host.settings.getSynced()).resolves.toEqual({
      theme: "dark",
      uv: { default_packages: ["numpy", "pandas"] },
    });
    expect(changed).toHaveBeenLastCalledWith({
      theme: "dark",
      uv: { default_packages: ["numpy", "pandas"] },
    });

    await expect(host.settings.rotateInstallId()).resolves.toEqual(expect.any(String));
    const snapshot = await host.settings.getSynced();
    expect(snapshot.install_id).toEqual(expect.any(String));

    unlisten();
    await host.settings.setSynced("theme", "light");
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
