import assert from "node:assert/strict";
import test from "node:test";

import type { CloudflareWebSocket, DurableObjectState, Env } from "../src/cloudflare-types.ts";
import {
  WORKSTATION_EVENTS_PING,
  WORKSTATION_EVENTS_PONG,
  WorkstationEvents,
} from "../src/workstation-events.ts";

test("workstation events configures hibernatable auto-response", () => {
  const pairs: Array<{ request: string; response: string }> = [];
  const globals = globalThis as {
    WebSocketRequestResponsePair?: new (
      request: string,
      response: string,
    ) => {
      request: string;
      response: string;
    };
  };
  const original = globals.WebSocketRequestResponsePair;
  globals.WebSocketRequestResponsePair = class {
    constructor(
      readonly request: string,
      readonly response: string,
    ) {}
  };
  try {
    new WorkstationEvents(
      {
        ...stateWithSockets([]),
        setWebSocketAutoResponse: (pair) => pairs.push(pair),
      },
      {} as Env,
    );
  } finally {
    globals.WebSocketRequestResponsePair = original;
  }

  assert.deepEqual(
    pairs.map((pair) => ({ request: pair.request, response: pair.response })),
    [
      {
        request: WORKSTATION_EVENTS_PING,
        response: WORKSTATION_EVENTS_PONG,
      },
    ],
  );
});

test("workstation events status uses hibernated sockets by workstation tag", async () => {
  const socket = new FakeSocket();
  const events = new WorkstationEvents(
    stateWithSockets([socket.asCloudflareWebSocket()]),
    {} as Env,
  );

  const response = await events.fetch(
    new Request("https://workstation-events.internal/status?workstation_id=ws-lab2"),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    connected: true,
    connections: 1,
  });
});

test("workstation events notify sends JSON wakeups to connected sockets", async () => {
  const socket = new FakeSocket();
  const events = new WorkstationEvents(
    stateWithSockets([socket.asCloudflareWebSocket()]),
    {} as Env,
  );

  const response = await events.fetch(
    new Request("https://workstation-events.internal/notify", {
      method: "POST",
      body: JSON.stringify({
        event: "attach_jobs",
        workstation_id: "ws-lab2",
        job_id: "job-1",
        notebook_id: "nb-1",
        status: "pending",
        requested_at: "2026-06-27T00:00:00.000Z",
        updated_at: "2026-06-27T00:00:00.000Z",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, delivered: 1 });
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    event: "attach_jobs",
    data: {
      event: "attach_jobs",
      workstation_id: "ws-lab2",
      job_id: "job-1",
      notebook_id: "nb-1",
      status: "pending",
      requested_at: "2026-06-27T00:00:00.000Z",
      updated_at: "2026-06-27T00:00:00.000Z",
    },
  });
});

test("workstation events answers ping in the non-hibernation fallback path", () => {
  const socket = new FakeSocket();
  const events = new WorkstationEvents(stateWithSockets([]), {} as Env);

  events.webSocketMessage(socket.asCloudflareWebSocket(), WORKSTATION_EVENTS_PING);

  assert.deepEqual(socket.sent, [WORKSTATION_EVENTS_PONG]);
});

test("workstation events stores socket attachment before hibernatable accept", () => {
  const calls: string[] = [];
  const socket = new FakeSocket({ calls });
  const events = new WorkstationEvents(
    {
      ...stateWithSockets([]),
      acceptWebSocket: () => calls.push("accept"),
    },
    {} as Env,
  );

  (
    events as unknown as {
      acceptSocket(socket: CloudflareWebSocket, attachment: unknown): void;
    }
  ).acceptSocket(socket.asCloudflareWebSocket(), {
    listenerId: "listener-1",
    workstationId: "ws-lab2",
    connectedAt: "2026-06-27T00:00:00.000Z",
  });

  assert.deepEqual(calls, ["serialize", "accept"]);
});

test("workstation events closes sockets when send fails", () => {
  const calls: string[] = [];
  const socket = new FakeSocket({ calls, failSend: true });
  const events = new WorkstationEvents(stateWithSockets([]), {} as Env);

  const sent = (
    events as unknown as {
      sendEvent(socket: CloudflareWebSocket, event: string, data: unknown): boolean;
    }
  ).sendEvent(socket.asCloudflareWebSocket(), "ready", { ok: true });

  assert.equal(sent, false);
  assert.deepEqual(calls, ["close:1011"]);
});

function stateWithSockets(sockets: CloudflareWebSocket[]): DurableObjectState {
  return {
    id: { toString: () => "workstation-events-test" },
    storage: {
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => false,
      list: async () => new Map(),
    },
    waitUntil: () => undefined,
    getWebSockets: (tag?: string) => (tag === "workstation:ws-lab2" ? sockets : []),
  };
}

class FakeSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly calls?: string[];
  private readonly failSend: boolean;

  constructor(options: { calls?: string[]; failSend?: boolean } = {}) {
    this.calls = options.calls;
    this.failSend = options.failSend ?? false;
  }

  accept(): void {}

  addEventListener(): void {}

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.failSend) {
      throw new Error("send failed");
    }
    assert.equal(typeof message, "string");
    this.sent.push(message as string);
  }

  close(code?: number): void {
    this.closed = true;
    this.calls?.push(`close:${code ?? "none"}`);
  }

  serializeAttachment(): void {
    this.calls?.push("serialize");
  }

  deserializeAttachment() {
    return {
      listenerId: "listener-1",
      workstationId: "ws-lab2",
      connectedAt: "2026-06-27T00:00:00.000Z",
    };
  }

  asCloudflareWebSocket(): CloudflareWebSocket {
    return this as unknown as CloudflareWebSocket;
  }
}
