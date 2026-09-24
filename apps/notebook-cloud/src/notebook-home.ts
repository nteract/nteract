import type { CloudflareWebSocket, DurableObjectState } from "./cloudflare-types.ts";

import { NOTEBOOK_HOME_PING, NOTEBOOK_HOME_PONG } from "./notebook-home-protocol.ts";
const CONNECTION_LEASE_MS = 5 * 60_000;

/** Per-principal invalidation stream. Catalog data and access remain in D1. */
export class NotebookHome {
  constructor(private readonly state: DurableObjectState) {
    const Pair = (
      globalThis as {
        WebSocketRequestResponsePair?: new (
          request: string,
          response: string,
        ) => {
          request: string;
          response: string;
        };
      }
    ).WebSocketRequestResponsePair;
    if (Pair) state.setWebSocketAutoResponse?.(new Pair(NOTEBOOK_HOME_PING, NOTEBOOK_HOME_PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/notify") {
      for (const socket of this.state.getWebSockets?.() ?? []) {
        if (this.expired(socket)) continue;
        this.send(socket, "changed");
      }
      return Response.json({ ok: true });
    }
    if (request.method !== "GET" || path !== "/stream") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected WebSocket upgrade", { status: 426 });
    }
    // Require the hibernation API: falling back to an in-memory socket list
    // would silently lose subscriptions when this object is evicted.
    if (!this.state.acceptWebSocket || !this.state.getWebSockets || !this.state.storage.setAlarm) {
      return new Response("hibernatable WebSockets unavailable", { status: 503 });
    }
    const pair = new WebSocketPair();
    const expiresAt = Date.now() + CONNECTION_LEASE_MS;
    pair[1].serializeAttachment?.({ expiresAt });
    this.state.acceptWebSocket(pair[1]);
    const alarm = await this.state.storage.getAlarm?.();
    if (!alarm || alarm > expiresAt) await this.state.storage.setAlarm(expiresAt);
    // Sent after registration. Refetching on ready closes the bootstrap /
    // subscription gap and recovers every reconnect without an event history.
    this.send(pair[1], "ready");
    const protocol = request.headers.get("Sec-WebSocket-Protocol");
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
    } as ResponseInit & { webSocket: CloudflareWebSocket });
  }

  async alarm(): Promise<void> {
    let next = Infinity;
    for (const socket of this.state.getWebSockets?.() ?? []) {
      if (!this.expired(socket)) next = Math.min(next, this.expiry(socket));
    }
    if (Number.isFinite(next)) await this.state.storage.setAlarm?.(next);
  }

  webSocketMessage(socket: CloudflareWebSocket, message: unknown): void {
    if (!this.expired(socket) && message === NOTEBOOK_HOME_PING) socket.send(NOTEBOOK_HOME_PONG);
  }

  webSocketClose(socket: CloudflareWebSocket): void {
    socket.close(1000, "closed");
  }
  webSocketError(socket: CloudflareWebSocket): void {
    socket.close(1011, "connection failed");
  }

  private expiry(socket: CloudflareWebSocket): number {
    const attachment = socket.deserializeAttachment?.() as { expiresAt?: number } | undefined;
    return typeof attachment?.expiresAt === "number" ? attachment.expiresAt : 0;
  }

  private expired(socket: CloudflareWebSocket): boolean {
    if (this.expiry(socket) > Date.now()) return false;
    socket.close(1000, "reauthenticate");
    return true;
  }

  private send(socket: CloudflareWebSocket, event: "ready" | "changed"): void {
    try {
      socket.send(JSON.stringify({ event }));
    } catch {
      socket.close(1011, "reconnect");
    }
  }
}
