// Isolated benchmark only. The runner supplies generated, already-admitted
// document histories; this is deliberately not a production ingress adapter.
import fixture from "./storage-fixture.json";

const decode = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const encode = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = fixture.map((entry) =>
  entry.docs.map((doc) => ({
    snapshot: decode(doc.snapshot),
    delta: decode(doc.delta),
  })),
);

export class StorageProbe {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");
    if (!["full", "changed", "incremental"].includes(mode))
      return new Response("mode", { status: 400 });
    if (url.pathname === "/restore") {
      const meta = await this.storage.get("meta");
      if (!meta) return new Response("empty", { status: 404 });
      const recovered = [];
      for (let d = 0; d < 4; d++) {
        const snapshot = await this.storage.get(`snapshot:${d}`);
        const chunks = await this.storage.list({ prefix: `chunk:${d}:` });
        const parts = [snapshot, ...chunks.values()];
        const combined = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
        let offset = 0;
        for (const part of parts) {
          combined.set(part, offset);
          offset += part.length;
        }
        recovered.push({ bytes: encode(combined), index: meta.index });
      }
      return Response.json(recovered);
    }
    const index = Number(url.searchParams.get("index"));
    if (!Number.isSafeInteger(index) || !fixture[index])
      return new Response("index", { status: 400 });
    const fault = url.searchParams.get("fault");
    let written = 0;
    let compactions = 0;
    let receipt;
    try {
      const commit = async (txn) => {
        const before = await txn.get("meta");
        if (before?.index === index) return { index, duplicate: true };
        // No-op checkpoints don't create operations or update metadata.
        if (mode !== "full" && before && fixture[index].docs.every((d) => !d.changed))
          return { index: before.index, unchanged: true };
        if (index !== (before?.index ?? -1) + 1) throw new Error("sequence conflict");
        const meta = {
          index,
          heads: fixture[index].docs.map((d) => d.heads),
          chunks: before?.chunks ?? [0, 0, 0, 0],
          sizes: before?.sizes ?? [0, 0, 0, 0],
        };
        const entries = {};
        for (let d = 0; d < 4; d++) {
          if (mode !== "full" && !fixture[index].docs[d].changed) continue;
          const { snapshot, delta } = bytes[index][d];
          if (mode !== "incremental" || !before) {
            entries[`snapshot:${d}`] = snapshot;
            written += snapshot.length;
          } else {
            const compact = meta.chunks[d] + 1 >= 32 || meta.sizes[d] + delta.length >= 65536;
            if (compact) {
              // Only delete the inventory included in this snapshot, within
              // the same runtime-owned transaction. This retains full history.
              const included = await txn.list({ prefix: `chunk:${d}:` });
              await txn.put(`snapshot:${d}`, snapshot);
              if (fault === "compact") throw new Error("injected compaction interruption");
              await txn.delete([...included.keys()]);
              meta.chunks[d] = 0;
              meta.sizes[d] = 0;
              written += snapshot.length;
              compactions++;
            } else {
              entries[`chunk:${d}:${String(index).padStart(6, "0")}`] = delta;
              meta.chunks[d]++;
              meta.sizes[d] += delta.length;
              written += delta.length;
            }
          }
        }
        // One receipt/frontier for the four distinct documents. A real ingress
        // must bind its operation ID and admitted changes before this boundary.
        entries.meta = meta;
        await Promise.all(Object.entries(entries).map(([key, value]) => txn.put(key, value)));
        if (fault === "commit") throw new Error("injected commit interruption");
        if (fault === "pause") {
          console.log("storage-probe-paused-before-commit");
          await new Promise((resolve) => setTimeout(resolve, 10000));
        }
        return { index, written, compactions };
      };
      // Full/changed follow RoomMaterializer's two reads and synchronous put
      // batch. Only the experimental chunk store needs the wider transaction.
      if (mode === "incremental") receipt = await this.storage.transaction(commit);
      else {
        await this.storage.get("meta");
        receipt = await commit(this.storage);
      }
      await this.storage.sync();
      if (fault === "ack") return new Response("injected lost response", { status: 503 });
      return Response.json(receipt);
    } catch (error) {
      return new Response(String(error), { status: 409 });
    }
  }
}

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/health") return new Response("ready");
    const room =
      new URL(request.url).searchParams.get("room") === "faults" ? "faults" : "benchmark";
    return env.PROBE.get(env.PROBE.idFromName(`generated-storage-probe-${room}`)).fetch(request);
  },
};
