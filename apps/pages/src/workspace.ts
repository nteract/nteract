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
}
interface Saved {
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
// JSON with byte arrays is a conservative, portable application budget, not a
// claim about celld's internal serialization or fleet durability setting.
export function checkStorageBudget(values: Record<string, unknown>): void {
  for (const value of Object.values(values)) {
    const encoded = JSON.stringify(value, (_key, item) =>
      item instanceof Uint8Array ? Array.from(item) : item,
    );
    requireValue(
      new TextEncoder().encode(encoded).length <= 1536 * 1024,
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
  ],
  block_kinds: ["markdown", "agent_instructions"],
  views: ["editing", "full"],
  streams: ["content"],
  edit_operations: [
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
  unsupported: [
    "multi_user_sharing",
    "scratch",
    "excerpts",
    "in_block_anchors",
    "native_artifacts",
    "comments",
    "files",
    "execution",
    "raw_crdt_ingress",
    "offline_sync",
  ],
};

/** One Durable Object per authenticated principal; each page is an independent Automerge document. */
export class PagesWorkspace {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly state: { storage: Storage }) {}

  fetch(request: Request): Promise<Response> {
    // Hashing and storage are async. Serialize across those awaits, not only SQLite writes.
    const task = this.queue.then(async () => {
      try {
        const principal = request.headers.get("x-pages-principal");
        requireValue(principal, "unauthorized", "Missing admitted identity");
        return json(await this.call(principal, await readBody(request)));
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
    this.queue = task.catch(() => {});
    return task;
  }

  async call(principal: string, body: Record<string, unknown>): Promise<unknown> {
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
    const saved = await this.state.storage.get<Saved>(id);
    if (!saved) throw new PageError("not_found", "Page not found", 404);
    const doc = A.load<Page>(new Uint8Array(saved.bytes));
    try {
      const full = await snapshot(doc, saved.sequence);
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
        };
      }
      requireValue(
        operation === "edit_page" || operation === "patch_page",
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
        digest = await hash(canonical({ operation, input }));
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
      requireValue(Array.isArray(input.operations), "invalid_request", "Missing operations");
      if (operation === "edit_page")
        requireValue(
          !input.operations.some((op) => object(op).op === "patch_block_markdown"),
          "unsupported_capability",
          "Use patch_page for literal patches with partial receipts",
        );
      const edited = await edit(doc, input.operations, operation === "patch_page");
      try {
        if (edited.receipts.every((receipt) => receipt.status === "rejected")) {
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
          new_sequence: sequence,
          through_sequence: sequence,
          operation_results: edited.receipts,
        };
        const before = new Map(full.blocks.map((b) => [b.id, b.hash]));
        const event: Change = {
          sequence,
          actor: principal,
          changed_block_ids: after.blocks
            .filter((b) => before.get(b.id) !== b.hash)
            .map((b) => b.id),
          deleted_block_ids: full.blocks
            .filter((b) => !edited.doc.order.includes(b.id))
            .map((b) => b.id),
          title_changed: full.title !== after.title,
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
