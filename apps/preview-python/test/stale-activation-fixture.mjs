import { startCelld } from "./local-celld.mjs";

export const fixtureConfig = {
  name: "python-runtime-probe",
  main: "index.js",
  no_bundle: true,
  compatibility_date: "2026-09-21",
  durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
  migrations: [{ tag: "stale-activation-v1", new_sqlite_classes: ["Room"] }],
};
export const fixtureEnvironment = { CELLD_IDLE_EVICT_S: "2" };

// One module/isolate retains resolvers across A's host-owned idle eviction.
// B reads attempt/outcome records without using the old activation's storage.
export const fixtureSource = `const jobs = new Map();
const activations = new Map();
const key = (instance, scenario) => instance + ":" + scenario;

export class Room {
  constructor(state) {
    this.state = state;
    this.instance = crypto.randomUUID();
    const cell = state.id.toString();
    this.activationNo = (activations.get(cell) || 0) + 1;
    activations.set(cell, this.activationNo);
  }
  async fetch(req) {
    const url = new URL(req.url);
    const scenario = url.searchParams.get("scenario") || "combined";
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const ws = pair[1];
      this.state.acceptWebSocket(ws);
      const job = { instance: this.instance, scenario, attempted: {}, outcomes: {}, errors: {}, settled: false, resolved: false };
      const gate = new Promise((resolve) => { job.resolve = resolve; });
      jobs.set(key(this.instance, scenario), job);
      this.state.waitUntil((async () => {
        let pending;
        try {
          await gate;
          job.resumed = true;
          if (scenario === "timer" || scenario === "timer-live") {
            pending = "timer";
            job.attempted.timer = true;
            await new Promise((resolve) => setTimeout(resolve, 1));
            job.outcomes.timer = "fulfilled";
          }
          // Keep the ticket-shaped awaited put then send in the combined leg.
          // KV-only and socket-only jobs have independent gates and state.
          if (scenario !== "socket") {
            pending = "kv";
            job.attempted.kv = true;
            await this.state.storage.put("completedBy:" + scenario, this.instance);
            job.outcomes.kv = "fulfilled";
          }
          if (scenario !== "kv") {
            pending = "socket";
            job.attempted.socket = true;
            ws.send(JSON.stringify({ type: "done", instance: this.instance, scenario }));
            job.outcomes.socket = "fulfilled";
          }
        } catch (error) {
          if (pending) { job.outcomes[pending] = "rejected"; job.errors[pending] = String(error); }
          job.error = String(error);
        } finally {
          job.settled = true;
        }
      })());
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/whoami")
      return Response.json({ instance: this.instance, activationNo: this.activationNo, cell: this.state.id.toString() });
    if (url.pathname === "/arm") {
      await this.state.storage.put("completedBy:" + scenario, url.searchParams.get("value"));
      return Response.json({ armed: true });
    }
    if (url.pathname === "/marker")
      return Response.json({ completedBy: await this.state.storage.get("completedBy:" + scenario) });
    if (url.pathname === "/resolve") {
      const job = jobs.get(key(url.searchParams.get("instance"), scenario));
      if (job && !job.resolved) { job.resolved = true; job.resolve(); }
      return Response.json({ resolved: Boolean(job) });
    }
    if (url.pathname === "/status") {
      const job = jobs.get(key(url.searchParams.get("instance"), scenario));
      if (!job) return Response.json(null);
      const { resolve, ...status } = job;
      return Response.json(status);
    }
    if (url.pathname === "/publish") {
      const sockets = this.state.getWebSockets();
      for (const ws of sockets) ws.send(JSON.stringify({ type: "hello", instance: this.instance }));
      return Response.json({ sent: sockets.length, instance: this.instance });
    }
    return new Response("probe-room");
  }
  webSocketMessage(ws, msg) {
    if (msg === "who") ws.send(JSON.stringify({ type: "who", instance: this.instance, activationNo: this.activationNo }));
  }
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.ROOM.get(env.ROOM.idFromName(url.searchParams.get("name") || "a"));
    return stub.fetch(new Request("https://do" + url.pathname + url.search, req));
  },
};`;

export async function startStaleActivationFixture(executable) {
  return startCelld({ "index.js": fixtureSource }, fixtureConfig, fixtureEnvironment, {
    executable,
  });
}
