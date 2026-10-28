// Local resource probe only. Never imported by Pages build/deployment entrypoints.
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { Repo, documentIdToBinary } from "@automerge/automerge-repo";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import { BufferedRecordStore, RemoteRecordSink } from "./pages/worker/record-persistence.mjs";
import { persistentSeed } from "./pages/worker/storage.mjs";
import { WebSocketByteTransport } from "./pages/shared/byte-transport.mjs";
export { PageRecords } from "./pages/worker/record-persistence.mjs";

export class BudgetPage {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.receivedPresence = [];
    this.maxSentFrameBytes = 0;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.signer = N.MemorySigner.fromBytes(await persistentSeed(ctx.storage));
      this.store = new BufferedRecordStore(
        new RemoteRecordSink(env.RECORDS.getByName(ctx.id.toString())),
      );
      await this.store.ready;
      this.backend = new SubductionBackend({
        signer: this.signer,
        storage: this.store,
        maxRecordBytes: 900 * 1024,
        maxSnapshotBytes: BUDGET_MIB * 1024 * 1024,
        syncTimeoutMilliseconds: 10000,
      });
      this.repo = new Repo({ backend: this.backend });
      this.documentId = await ctx.storage.get("documentId");
    });
  }
  async fetch(request) {
    await this.ready;
    const path = new URL(request.url).pathname;
    try {
      if (path === "/initialize") {
        this.documentId = (await request.json()).documentId;
        await this.ctx.storage.put("documentId", this.documentId);
        await this.ctx.storage.sync();
      } else if (path === "/ingest") {
        const rows = await request.json();
        const records = rows.map((r) => ({
          ...r,
          blob: Uint8Array.from(atob(r.blob), (c) => c.charCodeAt(0)),
        }));
        await this.backend.storeSnapshot(documentIdToBinary(this.documentId), records);
      } else if (path === "/flush") {
        await this.repo.flush([this.documentId]);
        await this.backend.flush();
        await this.store.flush();
        await this.ctx.storage.sync();
      } else if (
        path === "/summary" ||
        path === "/edit" ||
        path === "/presence" ||
        path === "/presence-state"
      ) {
        if (!this.handle) {
          this.handle = await this.repo.find(this.documentId, {
            signal: AbortSignal.timeout(30000),
          });
          this.handle.on("ephemeral-message", (event) => this.receivedPresence.push(event));
        }
        if (path === "/presence") {
          this.handle.broadcast({ probe: "host-cursor", offset: 3 });
          return Response.json({ sent: true });
        }
        if (path === "/presence-state") return Response.json({ messages: this.receivedPresence });
        if (path === "/edit") {
          this.handle.change((d) => {
            A.splice(
              d,
              ["blocks", "notes", "richText"],
              d.blocks.notes.richText.length,
              0,
              " celld budget edit",
            );
          });
          await this.repo.flush([this.documentId]);
          await this.backend.flush();
          await this.store.flush();
        }
        const doc = this.handle.doc();
        return Response.json({
          heads: A.getHeads(doc),
          missing: A.getMissingDeps(doc),
          changes: A.getAllChanges(doc).length,
          text: doc.blocks.notes.richText,
          textObject: A.getObjectId(doc.blocks.notes, "richText"),
          comment: doc.comments.discussion.target,
          records: this.store.values.size,
          storedBytes: this.store.size,
        });
      } else if (path === "/ws") {
        const pair = new WebSocketPair();
        pair[1].accept();
        const wire = new WebSocketByteTransport(pair[1], {
          maxFrameBytes: BUDGET_FRAME_MIB * 1024 * 1024,
          maxQueuedBytes: Math.max(8, BUDGET_FRAME_MIB) * 1024 * 1024,
        });
        const send = wire.sendBytes.bind(wire);
        wire.sendBytes = async (bytes) => {
          this.maxSentFrameBytes = Math.max(this.maxSentFrameBytes, bytes.length);
          try {
            await send(bytes);
          } catch (error) {
            console.error(
              "budget-send-failed",
              JSON.stringify({
                bytes: bytes.length,
                buffered: pair[1].bufferedAmount,
                error: String(error),
              }),
            );
            throw error;
          }
        };
        this.ctx.waitUntil(
          (async () => {
            const closed = new Promise((r) => wire.onDisconnect(r));
            const transport = await N.AuthenticatedTransport.accept(wire, this.signer);
            try {
              await this.backend.addConnection(transport);
            } finally {
              transport.free();
            }
            await closed;
          })().catch((e) => {
            console.error("budget-wire", e);
            void wire.disconnect();
          }),
        );
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      const id = this.signer.peerId();
      try {
        return Response.json({
          records: this.store.values.size,
          storedBytes: this.store.size,
          dirty: this.store.dirty,
          maxSentFrameBytes: this.maxSentFrameBytes,
          documentId: this.documentId,
          peer: Array.from(id.toBytes(), (b) => b.toString(16).padStart(2, "0")).join(""),
        });
      } finally {
        id.free();
      }
    } catch (error) {
      console.error("budget-probe", error);
      return Response.json({ error: String(error), cause: String(error.cause) }, { status: 500 });
    }
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== BUDGET_ORIGIN) return new Response("Local probe only", { status: 403 });
    if (url.pathname === "/health")
      return Response.json({ probe: "page7-budget", budgetMiB: BUDGET_MIB });
    return env.PAGES.getByName("budget-page").fetch(request);
  },
};
