import {
  readAgentGrant,
  authorizeAgentOperation,
  agentActorId,
  type AgentGrant,
} from "./agent-access.ts";
import * as A from "@automerge/automerge/slim";
import {
  canonical,
  createPage,
  edit,
  hash,
  selectSnapshot,
  snapshot,
  type Page,
} from "./document.ts";
import { PageError, json, object, readBody, requireValue, text } from "./errors.ts";
import { COMMENT_ACTIONS, prepareComment, projectComments, validateComments } from "./comments.ts";

import {
  actorPrefix,
  receiveAdmitted,
  SYNC_PROTOCOL,
  newActor,
  MAX_SYNC_BYTES,
  validatePage,
} from "./sync.ts";
import { readServerAppSession } from "../../notebook-cloud/src/oidc-session-store.ts";
import type { ServerOidcEnvironment } from "../../notebook-cloud/src/server-oidc.ts";
import type { CloudflareWebSocket } from "../../notebook-cloud/src/cloudflare-types.ts";

import { presence, presenceDisplayName } from "./presence.ts";

export interface AgentAuthor {
  display_name: string;
  driver: string;
  driver_id: string;
}
interface SyncPeer {
  eventsOnly: boolean;
  lastSequence: number;
  sentInitialEvent: boolean;
  sessionId: string;
  lastPresenceAt: number;
  socket: CloudflareWebSocket;
  principal: string;
  displayName: string | null;
  pageId: string | null;
  state: A.SyncState;
  request: Request;
  queued: number;
}
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(values: Record<string, unknown>): Promise<void>;
}
interface Change {
  sequence: number;
  actor: string;
  changed_block_ids: string[];
  deleted_block_ids: string[];
  title_changed: boolean;
  comments_changed?: boolean;
  operation_id?: string;
  attribution?: AgentAuthor;
}
interface Saved {
  authors?: Record<string, AgentAuthor>;
  bytes: Uint8Array;
  sequence: number;
  events: Change[];
  receipts: Record<string, { digest: string; result: unknown }>;
}
interface Entry {
  page_id: string;
  title: string;
  updated_at: string;
}
interface Catalog {
  principal: string;
  pages: Entry[];
}

// Budget the entire value, including history/receipts, before crossing storage.
// Binary bytes plus JSON metadata form a portable application budget, not a
// claim about celld's internal serialization or fleet durability setting.
export function checkStorageBudget(values: Record<string, unknown>, limit = 1536 * 1024): void {
  for (const value of Object.values(values)) {
    let binaryBytes = 0;
    const encoded = JSON.stringify(value, (_key, item) => {
      if (item instanceof Uint8Array) {
        binaryBytes += item.byteLength;
        return null;
      }
      return item;
    });
    requireValue(
      binaryBytes + new TextEncoder().encode(encoded).length <= limit,
      "page_limit_exceeded",
      "Stored Page or catalog exceeds the 1.5 MiB budget, including history and receipts",
    );
  }
}

export const CAPABILITIES = {
  service: "nteract-pages",
  schema_version: 2,
  operations: [
    "list_spaces",
    "get_space",
    "list_pages",
    "create_page",
    "read_page",
    "edit_page",
    "patch_page",
    "read_page_changes",
    "list_page_comments",
    "manage_page_comment",
    "reply_page_comment",
  ],
  text_formats: ["markdown", "automerge-rich-text-v1"],
  block_kinds: ["markdown", "agent_instructions"],
  views: ["editing", "full"],
  streams: ["content"],
  edit_operations: [
    "enable_rich_text",
    "set_title",
    "insert_markdown",
    "replace_block_markdown",
    "delete_block",
    "move_block",
    "set_block_metadata",
  ],
  limits: {
    request_bytes: 300000,
    page_bytes: 1048576,
    page_blocks: 1000,
    workspace_pages: 1000,
    operations: 100,
    retained_changes: 128,
    retained_receipts: 128,
  },
  sync: { protocol: SYNC_PROTOCOL, transport: "websocket", endpoint: "/api/sync" },
  agent_access: {
    approval_endpoint: "/api/agent-connections",
    scope: "single_page",
    permissions: ["read", "edit", "comment"],
    max_lifetime_seconds: 28800,
    events: {
      protocol: "nteract-pages-events-v1",
      transport: "websocket",
      endpoint: "/api/events",
    },
  },
  comments: {
    actions: COMMENT_ACTIONS,
    targets: ["block", "selection"],
    reactions: false,
    delete_thread: false,
    limits: { threads: 500, messages_per_thread: 500, message_bytes: 16000 },
  },
  unsupported: [
    "multi_user_sharing",
    "scratch",
    "excerpts",
    "in_block_anchors",
    "native_artifacts",
    "files",
    "execution",
    "offline_sync",
  ],
};

/** One Durable Object per authenticated principal; each page is an independent Automerge document. */
export class PagesWorkspace {
  private queue: Promise<unknown> = Promise.resolve();
  private peers = new Set<SyncPeer>();
  private queuedBytes = 0;
  /** Upgrade once under the workspace queue, before any replica can create threads. */
  private async ensureComments(id: string, principal: string) {
    const saved = await this.state.storage.get<Saved>(id);
    if (!saved) throw new PageError("not_found", "Page not found", 404);
    let doc = A.load<Page>(new Uint8Array(saved.bytes), {
      actor: newActor(await actorPrefix(principal)),
    });
    try {
      if (doc.comments) return;
      doc = A.change(doc, (d) => {
        d.comments = {};
      });
      const sequence = saved.sequence + 1;
      const values = {
        [id]: {
          ...saved,
          bytes: A.save(doc),
          sequence,
          events: [
            ...saved.events,
            {
              sequence,
              actor: principal,
              changed_block_ids: [],
              deleted_block_ids: [],
              title_changed: false,
              comments_changed: true,
            },
          ].slice(-128),
        },
      };
      // Reserve bounded migration headroom so a legacy Page at the normal
      // budget remains readable. Subsequent user mutations use the usual cap.
      checkStorageBudget(values, 1536 * 1024 + 4096);
      await this.state.storage.put(values);
    } finally {
      A.free(doc);
    }
  }
  constructor(
    private readonly state: {
      storage: Storage;
      acceptWebSocket?(socket: CloudflareWebSocket): void;
      getWebSockets?(): CloudflareWebSocket[];
    },
    private readonly env?: ServerOidcEnvironment,
  ) {
    // A hibernated instance has lost its ephemeral sync state. Ask clients to
    // start a fresh handshake; their document and pending journal survive.
    for (const socket of state.getWebSockets?.() ?? []) {
      try {
        socket.close(4000, "Reconnect after hibernation");
      } catch {}
    }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action);
    this.queue = task.catch(() => {});
    return task;
  }

  private async authorized(peer: SyncPeer): Promise<boolean> {
    if (!this.env) return false;
    if (peer.eventsOnly) {
      const grant = await readAgentGrant(this.env, peer.request);
      return (
        !!grant &&
        grant.principal === peer.principal &&
        grant.page_id === peer.pageId &&
        grant.permissions.includes("read")
      );
    }
    const session = await readServerAppSession(
      this.env,
      peer.request,
      Math.floor(Date.now() / 1000),
    );
    if (
      !session ||
      JSON.stringify([this.env.NOTEBOOK_CLOUD_OIDC_ISSUER, session.principal]) !== peer.principal
    )
      return false;
    peer.displayName = presenceDisplayName(session.displayName);
    return true;
  }

  private closePeer(peer: SyncPeer, code: number, reason: string) {
    this.peers.delete(peer);
    try {
      peer.socket.close(code, reason);
    } catch {
      /* Already disconnected. */
    }
  }

  private async connect(request: Request, principal: string): Promise<Response> {
    requireValue(this.peers.size < 64, "connection_limit", "Too many open connections");
    const catalog = await this.state.storage.get<Catalog>("catalog");
    requireValue(
      !catalog || catalog.principal === principal,
      "unauthorized",
      "Workspace identity mismatch",
    );
    const pageId = new URL(request.url).searchParams.get("page");
    if (pageId) {
      requireValue(/^page_[a-f0-9]{32}$/.test(pageId), "invalid_request", "Invalid Page ID");
      requireValue(await this.state.storage.get(pageId), "not_found", "Page not found");
      await this.ensureComments(pageId, principal);
    }
    const eventsOnly = new URL(request.url).pathname === "/events";
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
    requireValue(
      Number.isSafeInteger(since) && since >= 0,
      "invalid_request",
      "Invalid change cursor",
    );
    const pair = new WebSocketPair();
    const peer: SyncPeer = {
      eventsOnly,
      lastSequence: eventsOnly ? since : 0,
      sentInitialEvent: false,
      sessionId: crypto.randomUUID(),
      lastPresenceAt: 0,
      socket: pair[1],
      principal,
      displayName: null,
      pageId,
      state: A.initSyncState(),
      request,
      queued: 0,
    };
    requireValue(await this.authorized(peer), "unauthorized", "Sign in to sync Pages");
    requireValue(
      this.state.acceptWebSocket,
      "unsupported_runtime",
      "Runtime must support gated WebSockets",
    );
    this.state.acceptWebSocket(peer.socket);
    this.peers.add(peer);
    peer.socket.send(
      JSON.stringify({
        type: "hello",
        protocol: eventsOnly ? "nteract-pages-events-v1" : SYNC_PROTOCOL,
        flow_control: "durable-received",
        page_id: pageId,
        actor_prefix: await actorPrefix(principal),
        session_id: peer.sessionId,
        display_name: peer.displayName,
      }),
    );
    await this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  webSocketMessage(socket: CloudflareWebSocket, data: string | ArrayBuffer): Promise<void> {
    const peer = [...this.peers].find((peer) => peer.socket === socket);
    if (!peer) {
      socket.close(4000, "Reconnect after hibernation");
      return Promise.resolve();
    }
    const bytes = typeof data === "string" ? data.length * 2 : data.byteLength;
    if (bytes > MAX_SYNC_BYTES || peer.queued >= 16 || this.queuedBytes + bytes > 4 * 1024 * 1024) {
      this.closePeer(peer, 4008, "Too many queued frames");
      return Promise.resolve();
    }
    peer.queued++;
    this.queuedBytes += bytes;
    // Returning this promise keeps celld's event output gate attached through
    // persistence and every broadcast. celld 0.6.1 also gates self-polled
    // sockets through durability tickets; this path uses handler capture.
    return this.enqueue(async () => {
      try {
        if (!this.peers.has(peer)) return;
        if (!(await this.authorized(peer))) {
          this.closePeer(peer, 4001, "Sign in again");
          return;
        }
        if (data === "ping") {
          peer.socket.send("pong");
          return;
        }
        requireValue(!peer.eventsOnly, "invalid_request", "Event subscriptions accept ping only");
        if (typeof data === "string" && peer.pageId) {
          requireValue(data.length <= 8192, "invalid_presence", "Presence frame too large");
          const message = JSON.parse(data);
          requireValue(message.type === "presence", "invalid_presence", "Unknown control message");
          const value = presence(message.value);
          if (Date.now() - peer.lastPresenceAt >= 50 || value === null) {
            peer.lastPresenceAt = Date.now();
            await this.broadcastPresence(peer, value);
          }
          return;
        }
        requireValue(
          peer.pageId && data instanceof ArrayBuffer,
          "invalid_sync",
          "Send binary Automerge sync frames",
        );
        peer.state = await this.receiveSync(
          peer.principal,
          peer.pageId,
          peer.state,
          new Uint8Array(data),
        );
        await this.broadcast(peer);
      } catch (error) {
        if (error instanceof PageError) {
          peer.socket.send(
            JSON.stringify({ type: "rejected", code: error.code, message: error.message }),
          );
          this.closePeer(peer, 4002, "Sync rejected; local changes retained");
        } else this.closePeer(peer, 4011, "Sync interrupted; reconnect to recover");
      } finally {
        peer.queued--;
        this.queuedBytes -= bytes;
      }
    });
  }

  private async broadcastPresence(peer: SyncPeer, value: ReturnType<typeof presence>) {
    const payload = JSON.stringify({
      type: "presence",
      session_id: peer.sessionId,
      display_name: peer.displayName,
      value,
    });
    for (const recipient of this.peers) {
      if (
        recipient.eventsOnly ||
        recipient === peer ||
        recipient.pageId !== peer.pageId ||
        recipient.principal !== peer.principal
      )
        continue;
      if (await this.authorized(recipient)) {
        try {
          recipient.socket.send(payload);
        } catch {
          this.peers.delete(recipient);
        }
      } else this.closePeer(recipient, 4001, "Sign in again");
    }
  }

  webSocketClose(socket: CloudflareWebSocket) {
    this.webSocketError(socket);
  }
  webSocketError(socket: CloudflareWebSocket) {
    const peer = [...this.peers].find((peer) => peer.socket === socket);
    if (peer) {
      this.peers.delete(peer);
      return this.broadcastPresence(peer, null);
    }
  }

  /** Caller holds the workspace queue, shared by HTTP and WebSocket writes. */
  async receiveSync(
    principal: string,
    pageId: string,
    state: A.SyncState,
    message: Uint8Array,
  ): Promise<A.SyncState> {
    const catalog = await this.state.storage.get<Catalog>("catalog");
    requireValue(catalog?.principal === principal, "unauthorized", "Workspace identity mismatch");
    const saved = await this.state.storage.get<Saved>(pageId);
    requireValue(saved, "not_found", "Page not found");
    const doc = A.load<Page>(new Uint8Array(saved.bytes));
    try {
      const received = receiveAdmitted(doc, state, message, await actorPrefix(principal));
      try {
        if (received.changed) {
          for (const change of A.getChangesMetaSince(received.doc, A.getHeads(doc)))
            requireValue(
              !Object.hasOwn(saved.authors ?? {}, change.actor),
              "forbidden_actor",
              "Agent actors can only write through their authorized operations",
            );
          const before = await snapshot(doc, saved.sequence);
          const after = await snapshot(received.doc, saved.sequence + 1);
          const hashes = new Map(before.blocks.map((b) => [b.id, b.hash]));
          const event: Change = {
            sequence: after.through_sequence,
            actor: principal,
            changed_block_ids: after.blocks
              .filter((b) => hashes.get(b.id) !== b.hash)
              .map((b) => b.id),
            deleted_block_ids: before.blocks
              .filter((b) => !received.doc.order.includes(b.id))
              .map((b) => b.id),
            title_changed: before.title !== after.title,
            comments_changed:
              canonical(projectComments(doc)) !== canonical(projectComments(received.doc)),
          };
          const entry = catalog.pages.find((p) => p.page_id === pageId);
          requireValue(entry, "not_found", "Page is not in the space catalog");
          entry.title = after.title;
          entry.updated_at = new Date().toISOString();
          const values = {
            catalog,
            [pageId]: {
              ...saved,
              bytes: A.save(received.doc),
              sequence: after.through_sequence,
              events: [...saved.events, event].slice(-128),
            },
          };
          checkStorageBudget(values);
          await this.state.storage.put(values);
        }
        return received.state;
      } finally {
        A.free(received.doc);
      }
    } finally {
      A.free(doc);
    }
  }

  async generateSync(
    pageId: string,
    state: A.SyncState,
  ): Promise<{
    state: A.SyncState;
    message: Uint8Array | null;
    heads: string[];
    authors: Record<string, AgentAuthor>;
    sequence: number;
  }> {
    const saved = await this.state.storage.get<Saved>(pageId);
    requireValue(saved, "not_found", "Page not found");
    const doc = A.load<Page>(new Uint8Array(saved.bytes));
    try {
      const [next, message] = A.generateSyncMessage(doc, state);
      return {
        state: next,
        message,
        heads: A.getHeads(doc),
        sequence: saved.sequence,
        authors: saved.authors ?? {},
      };
    } finally {
      A.free(doc);
    }
  }

  private async broadcast(received?: SyncPeer) {
    const catalog = await this.state.storage.get<Catalog>("catalog");
    for (const peer of this.peers) {
      try {
        // Recheck before outbound data, too: a logged-out idle socket must not
        // keep reading just because another peer is the one making edits.
        if (!(await this.authorized(peer))) {
          this.closePeer(peer, 4001, "Sign in again");
          continue;
        }
        if (peer.eventsOnly && peer.pageId) {
          const saved = await this.state.storage.get<Saved>(peer.pageId);
          if (saved && (saved.sequence !== peer.lastSequence || !peer.sentInitialEvent)) {
            const value = await this.call(peer.principal, {
              operation: "read_page_changes",
              arguments: {
                page_id: peer.pageId,
                since_sequence: peer.lastSequence,
              },
            });
            peer.socket.send(JSON.stringify({ type: "page_changed", page_id: peer.pageId, value }));
            peer.lastSequence = saved.sequence;
            peer.sentInitialEvent = true;
          }
          continue;
        }
        peer.socket.send(JSON.stringify({ type: "catalog", pages: catalog?.pages ?? [] }));
        if (!peer.pageId) continue;
        const result = await this.generateSync(peer.pageId, peer.state);
        peer.state = result.state;
        peer.socket.send(JSON.stringify({ type: "authors", authors: result.authors }));
        if (result.message) peer.socket.send(result.message);
        // The heads describe storage read after its successful commit. A
        // protocol response alone is not a durable acknowledgement.
        peer.socket.send(
          JSON.stringify({
            type: "durable",
            heads: result.heads,
            sequence: result.sequence,
            // Only this peer's admitted binary frame earns a flow-control ack.
            // Unsolicited updates from another writer must not open its window.
            received: peer === received,
          }),
        );
      } catch {
        this.closePeer(peer, 4011, "Sync interrupted; reconnect to recover");
      }
    }
  }

  fetch(request: Request): Promise<Response> {
    // Hashing and storage are async. Serialize across those awaits, not only SQLite writes.
    const task = this.enqueue(async () => {
      try {
        const principal = request.headers.get("x-pages-principal");
        requireValue(principal, "unauthorized", "Missing admitted identity");
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket")
          return await this.connect(request, principal);
        if (new URL(request.url).pathname === "/recheck") {
          await this.broadcast();
          return json({ ok: true });
        }
        const body = await readBody(request);
        let grant: AgentGrant | null = null;
        if (request.headers.has("Authorization")) {
          grant = this.env ? await readAgentGrant(this.env, request) : null;
          if (!grant || grant.principal !== principal)
            throw new PageError("unauthorized", "Connection expired or revoked", 401);
          authorizeAgentOperation(grant, body);
        }
        const result = await this.call(principal, body, grant ?? undefined);
        await this.broadcast();
        return json(result);
      } catch (error) {
        if (error instanceof PageError)
          return json(
            { error: { code: error.code, message: error.message, commit_status: "not_committed" } },
            error.status,
          );
        // A storage error can follow a committed write. Preserve the original request key.
        return json(
          {
            error: {
              code: "storage_unavailable",
              message: "Read back or retry with the same idempotency_key",
              commit_status: "unknown",
            },
          },
          503,
        );
      }
    });
    return task;
  }

  async call(
    principal: string,
    body: Record<string, unknown>,
    grant?: AgentGrant,
  ): Promise<unknown> {
    if (grant) {
      requireValue(grant.principal === principal, "unauthorized", "Connection identity mismatch");
      authorizeAgentOperation(grant, body);
    }
    const operation = text(body.operation, "operation", 64);
    const input = object(body.arguments ?? {});
    requireValue(
      input.stream_kind === undefined || input.stream_kind === "content",
      "unsupported_capability",
      "Only the content stream is supported",
    );
    const catalog = (await this.state.storage.get<Catalog>("catalog")) ?? { principal, pages: [] };
    requireValue(catalog.principal === principal, "unauthorized", "Workspace identity mismatch");
    const spaceId = `space_${(await hash(principal)).slice(0, 32)}`;
    if (input.space_id !== undefined && input.space_id !== spaceId)
      throw new PageError("not_found", "Space not found", 404);
    const space = {
      id: spaceId,
      title: "Personal",
      root_page_id: null,
      capabilities: { private_workspace: true, multiple_spaces: false },
    };
    if (operation === "list_spaces") return { spaces: [space], next_cursor: null };
    if (operation === "get_space") return space;
    if (operation === "list_pages") return { pages: catalog.pages, next_cursor: null };

    if (operation === "create_page") {
      requireValue(
        input.parent_page_id === undefined || input.parent_page_id === null,
        "unsupported_capability",
        "Nested Pages are not implemented",
      );
      const key = text(input.idempotency_key, "idempotency_key", 128);
      requireValue(
        key.length >= 8,
        "invalid_request",
        "idempotency_key must contain 8–128 characters",
      );
      const id = `page_${(await hash(`${principal}\n${key}`)).slice(0, 32)}`;
      const digest = await hash(canonical(input));
      const existing = await this.state.storage.get<Saved>(id);
      if (existing) {
        const first = existing.receipts.create;
        if (!first || first.digest !== digest)
          throw new PageError(
            "idempotency_conflict",
            "Creation key was already used for different content",
            409,
          );
        return first.result;
      }
      requireValue(catalog.pages.length < 1000, "page_limit_exceeded", "Workspace has 1000 Pages");
      const doc = createPage(
        id,
        input.title ?? "Untitled",
        input.block_units ?? (input.markdown === undefined ? [] : [input.markdown]),
        newActor(await actorPrefix(principal)),
      );
      try {
        const content = await snapshot(doc, 1);
        const result = { page_id: id, space_id: spaceId, content, commit_status: "committed" };
        const saved: Saved = {
          bytes: A.save(doc),
          sequence: 1,
          events: [
            {
              sequence: 1,
              actor: principal,
              changed_block_ids: doc.order,
              deleted_block_ids: [],
              title_changed: true,
            },
          ],
          receipts: { create: { digest, result } },
        };
        catalog.pages.unshift({
          page_id: id,
          title: doc.title,
          updated_at: new Date().toISOString(),
        });
        const values = { catalog, [id]: saved };
        checkStorageBudget(values);
        await this.state.storage.put(values);
        return result;
      } finally {
        A.free(doc);
      }
    }

    const id = text(input.page_id, "page_id", 100);
    requireValue(/^page_[a-f0-9]{32}$/.test(id), "invalid_request", "Invalid Page ID");
    await this.ensureComments(id, principal);
    const saved = await this.state.storage.get<Saved>(id);
    if (!saved) throw new PageError("not_found", "Page not found", 404);
    const doc = A.load<Page>(new Uint8Array(saved.bytes));
    try {
      const full = await snapshot(doc, saved.sequence);
      if (operation === "list_page_comments") {
        requireValue(
          input.state == null || input.state === "open" || input.state === "resolved",
          "invalid_request",
          "Use open or resolved state",
        );
        const limit = input.limit ?? 100;
        requireValue(
          Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 500,
          "invalid_request",
          "Use limit 1–500",
        );
        const threads = projectComments(doc).filter(
          (t) =>
            (!input.state || t.state === input.state) &&
            (!input.block_id ||
              (t.target.kind === "block"
                ? t.target.blockId === input.block_id
                : t.target.anchor.blockId === input.block_id ||
                  t.target.head.blockId === input.block_id)),
        );
        return {
          page_id: id,
          sequence: saved.sequence,
          threads: threads.slice(0, Number(limit)),
          truncated: threads.length > Number(limit),
        };
      }
      if (operation === "read_page")
        return {
          ...selectSnapshot(full, input),
          metadata: { page_id: id, space_id: spaceId, drive_scope: "personal" },
        };
      if (operation === "read_page_changes") {
        const since = input.since_sequence;
        requireValue(
          Number.isSafeInteger(since) && (since as number) >= 0,
          "invalid_request",
          "Use an observed since_sequence",
        );
        if ((since as number) > saved.sequence || (since as number) < saved.events[0].sequence - 1)
          return { resync_required: true, through_sequence: saved.sequence };
        const changes = saved.events.filter((e) => e.sequence > (since as number));
        const changed = new Set(changes.flatMap((e) => e.changed_block_ids));
        const deleted = [...new Set(changes.flatMap((e) => e.deleted_block_ids))].filter(
          (b) => !doc.order.includes(b),
        );
        return {
          resync_required: false,
          through_sequence: saved.sequence,
          changes,
          blocks: full.blocks.filter((b) => changed.has(b.id)),
          deleted_block_ids: deleted,
          title: full.title,
          title_hash: full.title_hash,
          block_order: full.blocks.map((b) => b.id),
          comments_changed: changes.some((c) => c.comments_changed),
          authors: saved.authors ?? {},
        };
      }
      requireValue(
        ["edit_page", "patch_page", "manage_page_comment", "reply_page_comment"].includes(
          operation,
        ),
        "unsupported_capability",
        "Unsupported operation",
      );
      const key = text(input.idempotency_key, "idempotency_key", 128);
      requireValue(
        key.length >= 8,
        "invalid_request",
        "idempotency_key must contain 8–128 characters",
      );
      const receiptKey = `edit_${await hash(key)}`,
        digest = await hash(
          canonical(grant ? { operation, input, driver_id: grant.id } : { operation, input }),
        );
      const previous = saved.receipts[receiptKey];
      if (previous) {
        if (previous.digest !== digest)
          throw new PageError(
            "idempotency_conflict",
            "Request key was already used for another edit",
            409,
          );
        return previous.result;
      }
      // A sequence is mandatory for every mutation. It also makes an old, evicted
      // idempotency key fail closed instead of replaying after the receipt window.
      if (input.base_sequence !== saved.sequence)
        throw new PageError("edit_conflict", "Page changed; reread and rebuild the edit", 409);
      const comment =
        operation === "manage_page_comment" || operation === "reply_page_comment"
          ? prepareComment(
              doc,
              operation === "reply_page_comment" ? { ...input, action: "reply" } : input,
            )
          : null;
      if (!comment)
        requireValue(Array.isArray(input.operations), "invalid_request", "Missing operations");
      if (operation === "edit_page")
        requireValue(
          !(input.operations as unknown[]).some((op) => object(op).op === "patch_block_markdown"),
          "unsupported_capability",
          "Use patch_page for literal patches with partial receipts",
        );
      const prefix = await actorPrefix(principal);
      const actor = grant ? await agentActorId(prefix, grant.id) : newActor(prefix);
      const attribution = grant
        ? { display_name: grant.display_name, driver: grant.driver, driver_id: grant.id }
        : undefined;
      const operationId = `op_${(await hash(`${principal}:${grant?.id ?? "browser"}:${key}`)).slice(0, 32)}`;
      const edited = comment
        ? (() => {
            let next = A.clone(doc, { actor });
            try {
              next = A.change(next, comment.apply);
              validatePage(next, id);
              validateComments(next, doc, prefix);
              return { doc: next, receipts: [] };
            } catch (error) {
              A.free(next);
              throw error;
            }
          })()
        : await edit(doc, input.operations as unknown[], operation === "patch_page", actor);
      try {
        if (!comment && edited.receipts.every((receipt) => receipt.status === "rejected")) {
          return {
            commit_status: "not_committed",
            through_sequence: saved.sequence,
            operation_results: edited.receipts,
          };
        }
        const sequence = saved.sequence + 1;
        const after = await snapshot(edited.doc, sequence);
        const result = {
          commit_status: "committed",
          operation_id: operationId,
          ...(attribution ? { attribution } : {}),
          new_sequence: sequence,
          through_sequence: sequence,
          operation_results: edited.receipts,
          ...(comment
            ? {
                page_id: id,
                sequence,
                thread_id: comment.threadId,
                message_id: comment.messageId,
                thread: projectComments(edited.doc).find((t) => t.id === comment.threadId),
                truncated: false,
              }
            : {}),
        };
        const before = new Map(full.blocks.map((b) => [b.id, b.hash]));
        const event: Change = {
          sequence,
          actor: principal,
          operation_id: operationId,
          ...(attribution ? { attribution } : {}),
          changed_block_ids: after.blocks
            .filter((b) => before.get(b.id) !== b.hash)
            .map((b) => b.id),
          deleted_block_ids: full.blocks
            .filter((b) => !edited.doc.order.includes(b.id))
            .map((b) => b.id),
          title_changed: full.title !== after.title,
          comments_changed: !!comment,
        };
        const receipts = { ...saved.receipts, [receiptKey]: { digest, result } };
        const keys = Object.keys(receipts).filter((k) => k !== "create");
        for (const expired of keys.slice(0, -128)) delete receipts[expired];
        const bytes = A.save(edited.doc);
        const entry = catalog.pages.find((p) => p.page_id === id)!;
        entry.title = after.title;
        entry.updated_at = new Date().toISOString();
        const values = {
          catalog,
          [id]: {
            bytes,
            sequence,
            receipts,
            events: [...saved.events, event].slice(-128),
            authors: attribution ? { ...saved.authors, [actor]: attribution } : saved.authors,
          } satisfies Saved,
        };
        checkStorageBudget(values);
        await this.state.storage.put(values);
        return result;
      } finally {
        A.free(edited.doc);
      }
    } finally {
      A.free(doc);
    }
  }
}
