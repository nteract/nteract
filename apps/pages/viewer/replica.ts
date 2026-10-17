import * as A from "@automerge/automerge/slim";
import { block, type Page, type Snapshot, type Kind } from "../src/document.ts";
import { newActor, SYNC_PROTOCOL, validatePage, MAX_SYNC_BYTES } from "../src/sync.ts";
import { clearPending, pendingReplicas, savePending, type PendingReplica } from "./journal.ts";

export type SyncStatus = "connecting" | "syncing" | "saved" | "offline" | "signed_out" | "rejected";
export interface ReplicaUpdate {
  page: Snapshot | null;
  status: SyncStatus;
  error: string | null;
}

/** Isolate unreadable journals without deleting their only recovery bytes. */
export function restorePending(base: A.Doc<Page>, pageId: string, records: PendingReplica[]) {
  let doc = A.load<Page>(A.save(base), { actor: A.getActorId(base) });
  const recovered: PendingReplica[] = [],
    unreadable: PendingReplica[] = [];
  for (const record of records) {
    let loaded: A.Doc<Page> | null = null,
      candidate: A.Doc<Page> | null = null;
    try {
      loaded = A.load<Page>(new Uint8Array(record.bytes));
      validatePage(loaded, pageId);
      candidate = A.clone(doc, { actor: A.getActorId(doc) });
      candidate = A.merge(candidate, loaded);
      validatePage(candidate, pageId);
      [doc] = A.applyChanges(doc, A.getChanges(doc, candidate));
      recovered.push(record);
    } catch {
      unreadable.push(record);
    } finally {
      if (loaded) A.free(loaded);
      if (candidate) A.free(candidate);
    }
  }
  return { doc, recovered, unreadable };
}

/** One browser Automerge replica. React consumes projections, never a second document. */
export class PageReplica {
  doc: A.Doc<Page> | null = null;
  private observers = new Set<{ before: () => void; after: () => void }>();
  observe(observer: { before: () => void; after: () => void }) {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  private willChange() {
    for (const observer of this.observers) observer.before();
  }
  private sync = A.initSyncState();
  private socket: WebSocket | null = null;
  private active = true;
  private ready = false;
  private awaitingReceipt = false;
  private paused = false;
  private discarded = false;
  private attempts = 0;
  private receivedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private inbound: Promise<void> = Promise.resolve();
  private persistence: Promise<void> = Promise.resolve();
  private scope: string;
  private journalKey = crypto.randomUUID();
  private revision = 0;
  private writtenRevision = 0;
  private recovered: PendingReplica[] = [];
  private unreadable: PendingReplica[] = [];
  private durableHeads: string[] | null = null;
  private sequence = 0;
  private problem: string | null = null;
  private status: SyncStatus = "connecting";
  constructor(
    readonly account: string,
    readonly pageId: string | null,
    private readonly changed: (value: ReplicaUpdate) => void,
    private readonly catalog: (
      pages: { page_id: string; title: string; updated_at: string }[],
    ) => void,
    private readonly renew: () => Promise<boolean>,
  ) {
    this.scope = JSON.stringify([account, pageId]);
  }

  start() {
    void this.connect();
  }
  private async connect() {
    if (!this.active || this.paused) return;
    this.status = this.doc ? "offline" : "connecting";
    this.emit();
    try {
      if (!(await this.renew())) {
        this.status = "signed_out";
        this.emit();
        return;
      }
      if (!this.active || this.paused) return;
      if (!this.unreadable.length) this.problem = null;
      const url = new URL("/api/sync", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (this.pageId) url.searchParams.set("page", this.pageId);
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      this.sync = A.initSyncState();
      this.ready = false;
      this.awaitingReceipt = false;
      this.durableHeads = null;
      socket.onmessage = (event) => {
        this.inbound = this.inbound
          .then(async () => {
            if (this.socket !== socket || !this.active) return;
            this.receivedAt = Date.now();
            if (event.data === "pong") return;
            if (typeof event.data === "string") await this.control(JSON.parse(event.data));
            else if (event.data instanceof ArrayBuffer) {
              if (!this.doc || event.data.byteLength > MAX_SYNC_BYTES)
                throw Error("Invalid sync frame");
              this.willChange();
              [this.doc, this.sync] = A.receiveSyncMessage(
                this.doc,
                this.sync,
                new Uint8Array(event.data),
              );
              if (this.doc.page_id) validatePage(this.doc, this.pageId!);
              this.emit();
              this.schedule();
            } else throw Error("Invalid sync message");
          })
          .catch((error) => {
            this.problem = String(error instanceof Error ? error.message : error);
            this.paused = true;
            this.status = "rejected";
            this.emit();
            socket.close(4002, "Local replica retained");
          });
      };
      socket.onopen = () => {
        this.receivedAt = Date.now();
        this.heartbeat = setInterval(() => {
          if (this.socket !== socket) return;
          if (Date.now() - this.receivedAt > 45000) socket.close(4000, "Reconnect");
          else if (socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, 15000);
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        clearInterval(this.heartbeat);
        this.socket = null;
        this.ready = false;
        if (!this.active || this.paused) return;
        if (event.code === 4008) {
          this.paused = true;
          this.status = "rejected";
          this.problem =
            "The sync limit was reached. Download your recovery copy or reopen the saved version.";
          this.emit();
          return;
        }
        this.status = event.code === 4001 ? "signed_out" : "offline";
        this.emit();
        this.timer = setTimeout(
          () => void this.connect(),
          Math.min(10000, 500 * 2 ** this.attempts++),
        );
      };
    } catch (error) {
      this.problem = String(error instanceof Error ? error.message : error);
      this.status = "offline";
      this.emit();
      if (this.active) this.timer = setTimeout(() => void this.connect(), 3000);
    }
  }
  private async control(message: Record<string, unknown>) {
    if (message.type === "hello") {
      if (
        message.protocol !== SYNC_PROTOCOL ||
        message.flow_control !== "durable-received" ||
        message.page_id !== this.pageId ||
        typeof message.actor_prefix !== "string" ||
        !/^[a-f0-9]{32}$/.test(message.actor_prefix)
      )
        throw Error("Unsupported sync handshake");
      if (this.pageId && !this.doc) {
        this.doc = A.init<Page>({ actor: newActor(message.actor_prefix) });
        try {
          this.recovered = await pendingReplicas(this.scope);
        } catch {
          this.problem =
            "Local recovery storage is unavailable. Keep this tab open until edits are saved.";
        }
        if (!this.active) return;
        const result = restorePending(this.doc, this.pageId, this.recovered);
        A.free(this.doc);
        this.doc = result.doc;
        this.recovered = result.recovered;
        this.unreadable = result.unreadable;
        if (this.unreadable.length)
          this.problem =
            "Some local recovery data could not be read. It has been retained; download a recovery copy. The saved document is still available.";
      }
      this.ready = true;
      this.attempts = 0;
      this.status = "syncing";
      this.emit();
      this.schedule();
    } else if (message.type === "catalog") {
      if (Array.isArray(message.pages))
        this.catalog(message.pages as { page_id: string; title: string; updated_at: string }[]);
    } else if (message.type === "durable") {
      if (
        !Array.isArray(message.heads) ||
        !message.heads.every((h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h)) ||
        !Number.isSafeInteger(message.sequence)
      )
        throw Error("Invalid durable acknowledgement");
      this.durableHeads = message.heads;
      this.sequence = message.sequence as number;
      if (message.received === true) this.awaitingReceipt = false;
      this.emit();
      this.schedule();
    } else if (message.type === "rejected") {
      this.paused = true;
      this.status = "rejected";
      this.problem =
        typeof message.message === "string"
          ? message.message
          : "Server rejected changes; local replica retained";
      this.emit();
    } else throw Error("Unknown sync message");
  }
  isSaved(): boolean {
    return (
      !!this.doc &&
      !!this.durableHeads &&
      A.hasHeads(this.doc, this.durableHeads) &&
      A.getChangesSince(this.doc, this.durableHeads).length === 0
    );
  }
  private emit() {
    if (!this.active) return;
    if (this.ready && !this.paused) this.status = this.isSaved() ? "saved" : "syncing";
    const doc = this.doc;
    const page = doc?.page_id
      ? {
          schema_version: 2 as const,
          page_id: doc.page_id,
          title: doc.title,
          title_hash: "",
          through_sequence: this.sequence,
          blocks: doc.order.map((id) => ({
            ...doc.blocks[id],
            metadata: JSON.parse(JSON.stringify(doc.blocks[id].metadata)),
            hash: "",
          })),
        }
      : null;
    for (const observer of this.observers) observer.after();
    this.changed({ page, status: this.status, error: this.problem });
  }
  private schedule() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, 30);
  }
  private async flush() {
    if (!this.doc?.page_id) return this.send();
    const saved = this.isSaved(),
      revision = ++this.revision;
    const record: PendingReplica = {
      key: this.journalKey,
      scope: this.scope,
      revision,
      bytes: A.save(this.doc),
    };
    const recovered = this.recovered.map((r) => ({ key: r.key, revision: r.revision }));
    this.persistence = this.persistence.then(async () => {
      try {
        if (saved) {
          await clearPending([
            ...recovered,
            { key: this.journalKey, revision: this.writtenRevision },
          ]);
          this.recovered = [];
        } else {
          await savePending(record);
          this.writtenRevision = revision;
        }
      } catch {
        this.problem =
          "Local recovery storage is unavailable. Keep this tab open until edits are saved.";
        this.emit();
      }
    });
    await this.persistence;
    this.send();
  }
  private send() {
    if (
      !this.active ||
      !this.ready ||
      this.awaitingReceipt ||
      this.paused ||
      !this.doc ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    const [state, message] = A.generateSyncMessage(this.doc, this.sync);
    this.sync = state;
    if (message && message.byteLength > MAX_SYNC_BYTES) {
      this.paused = true;
      this.status = "rejected";
      this.problem =
        "Pending changes exceed the sync limit. Download a recovery copy or reopen the saved version.";
      this.emit();
      this.socket.close(4008, "Sync frame too large");
      return;
    }
    if (message) {
      // Automerge may generate another message when local heads advance even
      // with a message in flight. Bound transport work independently so slow
      // durable commits coalesce typing instead of overflowing the server.
      this.awaitingReceipt = true;
      this.socket.send(message);
    }
  }
  change(action: (doc: Page) => void) {
    if (!this.doc?.page_id || this.paused || this.status === "signed_out")
      throw Error("Wait for the document to connect");
    let next = A.clone(this.doc, { actor: A.getActorId(this.doc) });
    try {
      next = A.change(next, action);
      validatePage(next, this.pageId!);
    } catch (error) {
      A.free(next);
      throw error;
    }
    // clone() shares unchanged materialized objects with its source. Swapping
    // in the clone and freeing the source leaves those objects' WASM handles
    // dangling (notably blocks after a title-only edit). Admit validated bytes
    // into the existing handle instead, then release only the preview clone.
    const changes = A.getChanges(this.doc, next);
    A.free(next);
    this.willChange();
    [this.doc] = A.applyChanges(this.doc, changes);
    this.emit();
    this.schedule();
  }
  text(id: string | null, source: string) {
    this.change((d) => A.updateText(d, id ? ["blocks", id, "markdown"] : ["title"], source));
  }
  add(kind: Kind) {
    const value = block({ kind, markdown: "" });
    this.change((d) => {
      d.blocks[value.id] = value;
      d.order.push(value.id);
    });
    return value.id;
  }
  remove(id: string) {
    this.change((d) => {
      const i = d.order.indexOf(id);
      if (i >= 0) d.order.splice(i, 1);
      delete d.blocks[id];
    });
  }
  async discardPending() {
    this.active = false;
    this.paused = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    clearTimeout(this.flushTimer);
    this.socket?.close(1000, "Reopening saved version");
    this.socket = null;
    await this.persistence;
    await clearPending([
      ...this.recovered.map((r) => ({ key: r.key, revision: r.revision })),
      { key: this.journalKey, revision: this.writtenRevision },
    ]);
    this.discarded = true;
  }
  hasRecovery() {
    return !this.isSaved() || this.unreadable.length > 0;
  }
  download() {
    if (!this.doc) return;
    const bytes = new Uint8Array(A.save(this.doc));
    const contents = this.unreadable.length
      ? JSON.stringify({
          format: "nteract-pages-recovery-v1",
          page_id: this.pageId,
          document: Array.from(bytes),
          unreadable: this.unreadable.map((r) => ({
            key: r.key,
            revision: r.revision,
            bytes: Array.from(new Uint8Array(r.bytes)),
          })),
        })
      : bytes.buffer;
    const link = document.createElement("a"),
      url = URL.createObjectURL(new Blob([contents]));
    link.href = url;
    link.download = this.unreadable.length ? "page-recovery.json" : "page-recovery.automerge";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  dispose() {
    this.active = false;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    clearTimeout(this.flushTimer);
    if (!this.discarded) void this.flush();
    this.socket?.close(1000, "Page closed");
    this.socket = null;
    // The last queued flush captured its own bytes; no later network callback can use this handle.
    if (this.doc) A.free(this.doc);
    this.doc = null;
  }
}
