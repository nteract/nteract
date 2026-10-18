import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { Repo } from "@automerge/automerge-repo";
import { SubductionBackend, IndexedDBByteStore } from "@automerge/automerge-repo-subduction";
import { applyComment } from "../model/comments.mjs";
import { projectPage } from "../model/page.mjs";
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (value) => Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
export async function request(url, options = {}) {
  const response = await fetch(url, options),
    body = await response.json();
  if (!response.ok)
    throw Error(body.error?.message ?? body.error ?? `Request failed (${response.status})`);
  return body;
}
export function tool(operation, args = {}) {
  return request("/api/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, arguments: args }),
  });
}
async function exclusiveIdentity(scope) {
  const key = `pages-native:${scope}`;
  let seed = sessionStorage.getItem(key) || hex(crypto.getRandomValues(new Uint8Array(32)));
  let release = () => {};
  if (navigator.locks) {
    for (;;) {
      let ready;
      const acquired = new Promise((resolve) => (ready = resolve));
      void navigator.locks.request(`pages-native:${seed}`, { ifAvailable: true }, (lock) => {
        ready(!!lock);
        if (lock) return new Promise((resolve) => (release = resolve));
      });
      if (await acquired) break;
      // Duplicated tabs inherit sessionStorage; give each backend exclusive
      // ownership rather than concurrently opening one database/signing key.
      seed = hex(crypto.getRandomValues(new Uint8Array(32)));
    }
  } else seed = hex(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(key, seed);
  return { seed, release, reloadRecovery: !!navigator.locks };
}
export class PageSession {
  listeners = new Set();
  observers = new Set();
  presenceObservers = new Set();
  peers = new Map();
  profiles = {};
  actorNames = new Map();
  toolHints = [];
  alive = true;
  composing = 0;
  localDepth = 0;
  status = "Connecting";
  problem = "";
  savedHeads = [];
  static async open(pageId) {
    const session = new PageSession(pageId);
    try {
      await session.start();
      return session;
    } catch (e) {
      await session.close();
      throw e;
    }
  }
  constructor(pageId) {
    this.pageId = pageId;
  }
  get doc() {
    return this.handle?.doc();
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    for (const fn of this.listeners) fn();
  }
  snapshot() {
    return this.doc ? projectPage(this.doc) : null;
  }
  async start() {
    this.connection = await request(`/api/connect?page=${encodeURIComponent(this.pageId)}`);
    this.identity = this.connection.identity;
    this.profiles = this.connection.peerProfiles ?? {};
    this.canWrite = this.connection.canWrite;
    const scope = hex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${this.identity.principal}\0${this.pageId}`),
        ),
      ),
    );
    this.local = await exclusiveIdentity(scope);
    this.signer = N.MemorySigner.fromBytes(bytes(this.local.seed));
    const peer = this.signer.peerId();
    this.senderId = peer.toString();
    peer.free();
    this.storage = new IndexedDBByteStore({
      database: `pages-native-${scope}-${this.local.seed.slice(0, 16)}`,
    });
    this.backend = new SubductionBackend({
      signer: this.signer,
      storage: this.storage,
      syncTimeoutMilliseconds: 1000,
    });
    this.repo = new Repo({ backend: this.backend });
    await this.connect();
    this.handle = await this.repo.find(this.connection.documentId, {
      signal: AbortSignal.timeout(15000),
    });
    this.handle.on("change", (event) => {
      this.resolveToolHints();
      const change = { ...event, remote: this.localDepth === 0 };
      if (this.composing && change.remote) this.deferredBefore ??= event.patchInfo.before;
      else for (const fn of this.observers) fn(change);
      if (change.remote) this.queueSaved();
      this.emit();
    });
    this.handle.on("ephemeral-message", (event) => this.ephemeral(event));
    this.status = "Connected";
    if (!this.local.reloadRecovery)
      this.problem =
        "This browser keeps a local copy for this visit; same-tab reload recovery requires Web Locks.";
    this.presenceTimer = setInterval(() => {
      if (this.presenceValue) this.publishPresence(this.presenceValue);
    }, 10000);
    this.queueSaved();
  }
  async connect() {
    if (!this.alive) return;
    this.connection = await request(`/api/connect?page=${encodeURIComponent(this.pageId)}`);
    this.profiles = { ...this.profiles, ...this.connection.peerProfiles };
    this.identity = this.connection.identity;
    this.canWrite = this.connection.canWrite;
    const expected = new N.PeerId(bytes(this.connection.serverPeerId));
    const address = new URL(`/api/sync?page=${encodeURIComponent(this.pageId)}`, location.href);
    address.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      const socket = await N.SubductionWebSocket.tryConnect(address, this.signer, expected, () => {
        if (!this.alive) return;
        this.status = "Reconnecting";
        this.emit();
        this.scheduleReconnect();
      });
      if (!this.alive) {
        socket.free();
        return;
      }
      const transport = socket.toTransport();
      try {
        await this.backend.addConnection(transport);
      } finally {
        transport.free();
      }
      this.retryAttempts = 0;
      this.status = "Connected";
      this.emit();
      if (this.handle) this.queueSaved();
    } finally {
      expected.free();
    }
  }
  scheduleReconnect() {
    if (!this.alive || this.retryTimer) return;
    const delay = Math.min(10000, 500 * 2 ** (this.retryAttempts ?? 0));
    this.retryAttempts = (this.retryAttempts ?? 0) + 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect().catch((error) => {
        if (!this.alive) return;
        this.problem = error.message;
        this.status = "Offline";
        this.emit();
        this.scheduleReconnect();
      });
    }, delay);
  }
  observeChange(fn) {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }
  holdRemote() {
    this.composing++;
    return () => {
      this.composing = Math.max(0, this.composing - 1);
      if (!this.composing && this.deferredBefore) {
        const before = this.deferredBefore,
          after = this.doc;
        this.deferredBefore = null;
        const event = {
          doc: after,
          handle: this.handle,
          remote: true,
          patches: A.diff(after, A.getHeads(before), A.getHeads(after)),
          patchInfo: { before, after, source: "change" },
        };
        for (const fn of this.observers) fn(event);
      }
    };
  }
  change(fn) {
    if (!this.canWrite) throw Error("This Page is read only");
    this.localDepth++;
    try {
      const stored = this.handle.change(fn);
      this.queueSaved();
      Promise.resolve(stored).catch((error) => {
        this.problem = error.message;
        this.status = "Local save failed";
        this.emit();
      });
      return stored;
    } finally {
      this.localDepth--;
    }
  }
  comment(input) {
    return this.change((doc) => applyComment(doc, input, this.identity));
  }
  actorDisplayName(actor) {
    return this.actorNames.get(actor) ?? "Collaborator";
  }
  watchPresence(fn) {
    this.presenceObservers.add(fn);
    return () => this.presenceObservers.delete(fn);
  }
  publishPresence(value) {
    this.presenceValue = value;
    if (this.handle)
      try {
        this.handle.broadcast({ kind: "selection", value });
      } catch (error) {
        this.problem = error.message;
        this.emit();
      }
  }
  ephemeral({ senderId, message }) {
    if (!message || typeof message !== "object") return;
    if (senderId === this.connection.serverSenderId) {
      if (message.kind === "identity-profiles") {
        this.profiles = { ...this.profiles, ...message.peerProfiles };
        return;
      }
      if (message.kind === "tool-edit" && Array.isArray(message.heads)) {
        this.toolHints.push(message);
        this.toolHints = this.toolHints.slice(-64);
        this.resolveToolHints();
        return;
      }
    }
    if (message.kind !== "selection" || senderId === this.senderId) return;
    const profile = this.profiles[senderId];
    if (!profile) return;
    const value = message.value;
    if (
      value &&
      typeof value.block_id === "string" &&
      value.block_id.length <= 128 &&
      typeof value.start === "string" &&
      value.start.length <= 512 &&
      typeof value.end === "string" &&
      value.end.length <= 512 &&
      Array.isArray(value.heads) &&
      value.heads.length <= 100 &&
      value.heads.every((head) => typeof head === "string" && /^[0-9a-f]{64}$/.test(head))
    ) {
      this.peers.set(senderId, {
        value,
        at: Date.now(),
        displayName: [profile.displayName, profile.driver].filter(Boolean).join(" · "),
      });
    } else if (value === null) this.peers.delete(senderId);
    for (const fn of this.presenceObservers) fn();
  }
  resolveToolHints() {
    this.toolHints = this.toolHints.filter((message) => {
      let pending = false;
      const display = [message.identity?.displayName, message.identity?.driver]
        .filter(Boolean)
        .join(" · ");
      for (const head of message.heads) {
        try {
          const meta = A.inspectChange(this.doc, head);
          if (meta && display) this.actorNames.set(meta.actor, display);
          else pending = true;
        } catch {
          pending = true;
        }
      }
      return pending;
    });
  }
  queueSaved() {
    this.receiptRevision = (this.receiptRevision ?? 0) + 1;
    clearTimeout(this.savedTimer);
    this.status = "Saving";
    this.emit();
    this.savedTimer = setTimeout(() => void this.saveReceipt(), 300);
  }
  async saveReceipt() {
    if (!this.alive || !this.handle) return;
    const revision = this.receiptRevision;
    try {
      await this.repo.flush();
      const heads = A.getHeads(this.doc);
      const result = await request(`/api/saved?page=${encodeURIComponent(this.pageId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heads }),
      });
      if (!this.alive || revision !== this.receiptRevision) return;
      this.savedHeads = result.durableHeads;
      this.status = A.getHeads(this.doc).every((h) => this.savedHeads.includes(h))
        ? "Saved"
        : "Saving";
      this.emit();
    } catch (error) {
      if (this.alive && revision === this.receiptRevision) {
        this.problem = error.message;
        this.status = "Unsaved";
        this.emit();
      }
    }
  }
  async close() {
    this.alive = false;
    clearTimeout(this.savedTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.presenceTimer);
    try {
      await this.repo?.shutdown();
    } catch {}
    try {
      await this.backend?.close();
    } catch {}
    await this.storage?.close();
    this.signer?.free();
    this.local?.release();
  }
}
