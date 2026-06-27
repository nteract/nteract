import type { CloudflareWebSocket, DurableObjectState, Env } from "./cloudflare-types.ts";
import type { WebSocketRequestResponsePair } from "./cloudflare-types.ts";
import { cloudLog } from "./observability.ts";

export const WORKSTATION_EVENTS_PING = "nteract.workstation_events.ping.v1";
export const WORKSTATION_EVENTS_PONG = "nteract.workstation_events.pong.v1";

interface EventSocketAttachment {
  readonly listenerId: string;
  readonly workstationId: string | null;
  readonly connectedAt: string;
}

export interface WorkstationAttachJobNotification {
  event: "attach_jobs";
  workstation_id: string;
  job_id: string;
  notebook_id: string;
  status: string;
  requested_at: string;
  updated_at: string;
}

export function workstationEventsObjectName(ownerPrincipal: string, workstationId: string): string {
  return `${ownerPrincipal}\n${workstationId}`;
}

export class WorkstationEvents {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
    const pairCtor = (
      globalThis as {
        WebSocketRequestResponsePair?: new (
          request: string,
          response: string,
        ) => WebSocketRequestResponsePair;
      }
    ).WebSocketRequestResponsePair;
    if (pairCtor && this.state.setWebSocketAutoResponse) {
      this.state.setWebSocketAutoResponse(
        new pairCtor(WORKSTATION_EVENTS_PING, WORKSTATION_EVENTS_PONG),
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/stream") {
      return this.openSocket(request);
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const workstationId = workstationIdFromUrl(url);
      const connections = this.workstationSockets(workstationId).length;
      cloudLog("debug", "workstation.events.status", {
        workstation_id: workstationId,
        connected: connections > 0,
        connections,
        counter: "workstation_event_status_checks",
        counter_delta: 1,
      });
      return Response.json({
        ok: true,
        connected: connections > 0,
        connections,
      });
    }
    if (request.method === "POST" && url.pathname === "/notify") {
      const notification = await readNotification(request);
      if (notification instanceof Response) {
        return notification;
      }
      const delivered = this.broadcast(notification.event, notification);
      return Response.json({
        ok: true,
        delivered,
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  webSocketMessage(
    socket: CloudflareWebSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): void {
    if (message === WORKSTATION_EVENTS_PING) {
      socket.send(WORKSTATION_EVENTS_PONG);
    }
  }

  webSocketClose(socket: CloudflareWebSocket): void {
    this.logSocketClosed(socket, "closed");
  }

  webSocketError(socket: CloudflareWebSocket): void {
    this.logSocketClosed(socket, "errored");
  }

  private openSocket(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "expected WebSocket upgrade" }, { status: 426 });
    }
    const workstationId = workstationIdFromUrl(new URL(request.url));
    const listenerId = crypto.randomUUID();
    const connectedAt = new Date().toISOString();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: EventSocketAttachment = {
      listenerId,
      workstationId,
      connectedAt,
    };

    this.acceptSocket(server, attachment);
    cloudLog("info", "workstation.events.socket_opened", {
      workstation_id: workstationId,
      listener_id: listenerId,
      connections: this.workstationSockets(workstationId).length,
      counter: "workstation_event_sockets_opened",
      counter_delta: 1,
    });
    if (
      !this.sendEvent(server, "ready", {
        ok: true,
        connected_at: connectedAt,
      })
    ) {
      cloudLog("warn", "workstation.events.ready_send_failed", {
        workstation_id: workstationId,
        listener_id: listenerId,
        counter: "workstation_event_ready_send_failures",
        counter_delta: 1,
      });
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: CloudflareWebSocket });
  }

  private acceptSocket(socket: CloudflareWebSocket, attachment: EventSocketAttachment): void {
    if (this.state.acceptWebSocket && socket.serializeAttachment) {
      socket.serializeAttachment(attachment);
      this.state.acceptWebSocket(socket, [socketTag(attachment.workstationId)]);
      return;
    }

    socket.accept();
    socket.addEventListener("message", (event) => {
      this.webSocketMessage(socket, event.data);
    });
    socket.addEventListener("close", () => {
      this.webSocketClose(socket);
    });
    socket.addEventListener("error", () => {
      this.webSocketError(socket);
    });
  }

  private broadcast(event: string, data: unknown): number {
    let delivered = 0;
    for (const socket of this.workstationSockets(
      (data as { workstation_id?: unknown }).workstation_id,
    )) {
      if (this.sendEvent(socket, event, data)) {
        delivered += 1;
      }
    }
    return delivered;
  }

  private sendEvent(socket: CloudflareWebSocket, event: string, data: unknown): boolean {
    try {
      socket.send(JSON.stringify({ event, data }));
      return true;
    } catch {
      socket.close(1011, "workstation event delivery failed");
      return false;
    }
  }

  private workstationSockets(workstationId: unknown): CloudflareWebSocket[] {
    const tag = socketTag(typeof workstationId === "string" ? workstationId : null);
    return this.state.getWebSockets?.(tag) ?? [];
  }

  private logSocketClosed(socket: CloudflareWebSocket, reason: "closed" | "errored"): void {
    const attachment = socketAttachment(socket);
    cloudLog("info", "workstation.events.socket_closed", {
      workstation_id: attachment?.workstationId ?? null,
      listener_id: attachment?.listenerId ?? null,
      reason,
      counter: "workstation_event_sockets_closed",
      counter_delta: 1,
    });
  }
}

function workstationIdFromUrl(url: URL): string | null {
  const workstationId = url.searchParams.get("workstation_id")?.trim();
  return workstationId && workstationId.length <= 128 ? workstationId : null;
}

function socketTag(workstationId: string | null): string {
  return `workstation:${workstationId ?? "unknown"}`;
}

function socketAttachment(socket: CloudflareWebSocket): EventSocketAttachment | null {
  const value = socket.deserializeAttachment?.();
  if (!isRecord(value)) {
    return null;
  }
  const listenerId = stringField(value.listenerId);
  if (!listenerId) {
    return null;
  }
  return {
    listenerId,
    workstationId: stringField(value.workstationId) || null,
    connectedAt: stringField(value.connectedAt),
  };
}

async function readNotification(
  request: Request,
): Promise<WorkstationAttachJobNotification | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "notification body must be JSON" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return Response.json({ error: "notification body must be an object" }, { status: 400 });
  }
  const event = stringField(body.event);
  const notification = {
    event,
    workstation_id: stringField(body.workstation_id),
    job_id: stringField(body.job_id),
    notebook_id: stringField(body.notebook_id),
    status: stringField(body.status),
    requested_at: stringField(body.requested_at),
    updated_at: stringField(body.updated_at),
  };
  if (
    event !== "attach_jobs" ||
    !notification.workstation_id ||
    !notification.job_id ||
    !notification.notebook_id ||
    !notification.status ||
    !notification.requested_at ||
    !notification.updated_at
  ) {
    return Response.json({ error: "invalid notification body" }, { status: 400 });
  }
  return { ...notification, event };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
