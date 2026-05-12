// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://nteract-notebook.localhost:8443/"}
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
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
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

function fetchConfig(websocket_url = config.websocket_url) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ ...config, websocket_url }),
  })) as unknown as typeof fetch;
}

describe("createBrowserHost() with Portless", () => {
  it("uses the current HTTPS origin for loopback relay WebSockets", async () => {
    FakeWebSocket.instances = [];

    await createBrowserHost({
      fetchImpl: fetchConfig(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain("wss://nteract-notebook.localhost:8443/__nteract_dev_relay/ws");
    expect(ws.url).toContain("token=dev-token");
  });

  it("normalizes IPv6 loopback relay WebSockets", async () => {
    FakeWebSocket.instances = [];

    await createBrowserHost({
      fetchImpl: fetchConfig("ws://[::1]:5174/__nteract_dev_relay/ws"),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain("wss://nteract-notebook.localhost:8443/__nteract_dev_relay/ws");
    expect(ws.url).toContain("token=dev-token");
  });
});
