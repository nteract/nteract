import type { DurableObjectState, Env } from "./cloudflare-types.ts";
import { cloudLog } from "./observability.ts";

const WORKSTATION_EVENTS_KEEPALIVE_MS = 25_000;

interface EventListener {
  readonly id: string;
  readonly workstationId: string | null;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  closed: boolean;
  keepalive: ReturnType<typeof setInterval> | null;
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
  private readonly encoder = new TextEncoder();
  private readonly listeners = new Map<string, EventListener>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.state;
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/stream") {
      return this.openStream(request);
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const workstationId = workstationIdFromUrl(url);
      cloudLog("debug", "workstation.events.status", {
        workstation_id: workstationId,
        connected: this.listeners.size > 0,
        connections: this.listeners.size,
        counter: "workstation_event_status_checks",
        counter_delta: 1,
      });
      return Response.json({
        ok: true,
        connected: this.listeners.size > 0,
        connections: this.listeners.size,
      });
    }
    if (request.method === "POST" && url.pathname === "/notify") {
      const notification = await readNotification(request);
      if (notification instanceof Response) {
        return notification;
      }
      await this.broadcast(notification.event, notification);
      return Response.json({
        ok: true,
        delivered: this.listeners.size,
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private openStream(request: Request): Response {
    const workstationId = workstationIdFromUrl(new URL(request.url));
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const listener: EventListener = {
      id: crypto.randomUUID(),
      workstationId,
      writer: writable.getWriter(),
      closed: false,
      keepalive: null,
    };
    const close = () => {
      this.closeListener(listener);
    };
    request.signal.addEventListener("abort", close, { once: true });

    this.listeners.set(listener.id, listener);
    cloudLog("info", "workstation.events.stream_opened", {
      workstation_id: workstationId,
      listener_id: listener.id,
      connections: this.listeners.size,
      counter: "workstation_event_streams_opened",
      counter_delta: 1,
    });
    void this.writeEvent(listener, "ready", {
      ok: true,
      connected_at: new Date().toISOString(),
    }).catch(close);
    listener.keepalive = setInterval(() => {
      void this.writeComment(listener, "keepalive").catch(close);
    }, WORKSTATION_EVENTS_KEEPALIVE_MS);

    return new Response(readable, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  }

  private async broadcast(event: string, data: unknown): Promise<void> {
    await Promise.all(
      Array.from(this.listeners.values(), async (listener) => {
        try {
          await this.writeEvent(listener, event, data);
        } catch {
          this.closeListener(listener);
        }
      }),
    );
  }

  private async writeEvent(listener: EventListener, event: string, data: unknown): Promise<void> {
    if (listener.closed) {
      return;
    }
    await listener.writer.write(this.encoder.encode(formatServerSentEvent(event, data)));
  }

  private async writeComment(listener: EventListener, comment: string): Promise<void> {
    if (listener.closed) {
      return;
    }
    await listener.writer.write(this.encoder.encode(`: ${comment}\n\n`));
  }

  private closeListener(listener: EventListener): void {
    if (listener.closed) {
      return;
    }
    listener.closed = true;
    if (listener.keepalive) {
      clearInterval(listener.keepalive);
      listener.keepalive = null;
    }
    this.listeners.delete(listener.id);
    cloudLog("info", "workstation.events.stream_closed", {
      workstation_id: listener.workstationId,
      listener_id: listener.id,
      connections: this.listeners.size,
      counter: "workstation_event_streams_closed",
      counter_delta: 1,
    });
    void listener.writer.close().catch(() => undefined);
  }
}

function workstationIdFromUrl(url: URL): string | null {
  const workstationId = url.searchParams.get("workstation_id")?.trim();
  return workstationId && workstationId.length <= 128 ? workstationId : null;
}

function formatServerSentEvent(event: string, data: unknown): string {
  // This stream is a wakeup/presence path, not the durable attach-job log.
  // Attach jobs live in D1 and agents recover by polling the queue after a
  // reconnect, so we intentionally do not assign SSE ids or support
  // Last-Event-ID replay here.
  const payload = JSON.stringify(data);
  const dataLines = payload.split(/\r?\n/).map((line) => `data: ${line}`);
  return [`event: ${event}`, ...dataLines, ""].join("\n") + "\n";
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
