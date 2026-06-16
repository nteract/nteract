import { IndexedDbStorageAdapter, type ConnectionStatus, type StorageChunk } from "runtimed";
import type { CloudMarkdownDocumentConfig } from "./cloud-viewer-types";
import type { CloudAppSession } from "./app-session";
import {
  cloudPrincipalFromActorLabel,
  CloudWebSocketTransport,
  createCloudConnectTarget,
  withReadyTimeout,
  type CloudRoomReady,
} from "./live-sync";
import { cloudInstantPaintPrincipalMatcher } from "./instant-paint";
import {
  cloudSyncAuthFromAppSessionCookie,
  cloudSyncAuthFromPrototypeAuthState,
  fetchWithCloudPrototypeAuth,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { cloudResponseError } from "./cloud-response";
import {
  createBootstrapMarkdownHandle,
  loadMarkdownHandleFromBytes,
  type MarkdownHandle,
} from "./runtimed-wasm-client";
import { FrameType } from "../src/protocol";

export interface MarkdownDocumentLiveSnapshot {
  body: string;
  bodyReady: boolean;
  title: string;
}

export interface MarkdownDocumentLiveSyncController {
  readonly actorLabel: string;
  readonly peerId: string;
  readonly transport: CloudWebSocketTransport;
  editBody(nextBody: string): void;
  editTitle(nextTitle: string): void;
  flushNow(): Promise<void>;
  publishSnapshot(): Promise<MarkdownDocumentPublishedSnapshot>;
  dispose(): void;
}

export interface MarkdownDocumentPublishedSnapshot {
  headsHash: string;
  revisionId: string;
}

export interface StartMarkdownDocumentLiveSyncOptions {
  authState: CloudPrototypeAuthState;
  config: CloudMarkdownDocumentConfig;
  appSession: CloudAppSession | null;
  title: string;
  scope: "owner" | "editor" | "viewer";
  onConnectionLost?: (reason: Error) => void;
  onError?: (error: unknown) => void;
  onSnapshot: (snapshot: MarkdownDocumentLiveSnapshot) => void;
  onStatus?: (status: ConnectionStatus) => void;
}

const MARKDOWN_PERSISTENCE_KEY_SEGMENT = "markdown-doc";
const MARKDOWN_PERSISTENCE_SNAPSHOT_SEGMENT = "snapshot";
const MARKDOWN_PERSISTENCE_SAVE_DELAY_MS = 500;
const MARKDOWN_INSTANT_PAINT_READ_TIMEOUT_MS = 2_000;
const MARKDOWN_INSTANT_PAINT_ACTOR_LABEL = "system:markdown-instant-paint/browser:local";

export async function loadMarkdownDocumentInstantPaintSnapshot({
  authState,
  config,
  appSession,
  title,
  onError,
  readTimeoutMs = MARKDOWN_INSTANT_PAINT_READ_TIMEOUT_MS,
}: Pick<StartMarkdownDocumentLiveSyncOptions, "authState" | "config" | "appSession" | "title"> & {
  onError?: (error: unknown) => void;
  readTimeoutMs?: number;
}): Promise<MarkdownDocumentLiveSnapshot | null> {
  const adapter = IndexedDbStorageAdapter.create({ onError });
  if (!adapter) {
    return null;
  }
  const matchesPrincipal = cloudInstantPaintPrincipalMatcher(authState, {
    hasAppSession: Boolean(appSession),
  });
  if (!matchesPrincipal) {
    return null;
  }

  let records: StorageChunk[];
  try {
    records = await withReadyTimeout(
      adapter.loadRange([MARKDOWN_PERSISTENCE_KEY_SEGMENT, config.documentId]),
      readTimeoutMs,
      `persisted MarkdownDoc read did not settle within ${readTimeoutMs}ms`,
    );
  } catch (error) {
    console.warn("[notebook-cloud] Markdown instant-paint read failed; skipping paint", error);
    return null;
  }

  const seed = selectMarkdownInstantPaintRecord(records, matchesPrincipal);
  if (!seed) {
    return null;
  }

  const moduleUrl = new URL(config.runtimedWasmModulePath, location.href);
  const wasmUrl = new URL(config.runtimedWasmPath, location.href);
  let handle: MarkdownHandle | null = null;
  try {
    handle = await loadMarkdownHandleFromBytes(
      seed,
      MARKDOWN_INSTANT_PAINT_ACTOR_LABEL,
      moduleUrl,
      wasmUrl,
    );
    return {
      body: handle.body() ?? "",
      bodyReady: handle.body_len() != null,
      title: handle.title()?.trim() || title,
    };
  } catch (error) {
    console.warn(
      "[notebook-cloud] Markdown instant-paint snapshot load failed; skipping paint",
      error,
    );
    return null;
  } finally {
    handle?.free();
  }
}

export async function startMarkdownDocumentLiveSync({
  authState,
  config,
  appSession,
  title,
  scope,
  onConnectionLost,
  onError,
  onSnapshot,
  onStatus,
}: StartMarkdownDocumentLiveSyncOptions): Promise<MarkdownDocumentLiveSyncController> {
  const transport = new CloudWebSocketTransport({
    connectTarget: createCloudConnectTarget({
      syncEndpoint: config.syncEndpoint,
      resolveAuth: (sessionId) =>
        appSession
          ? cloudSyncAuthFromAppSessionCookie({ requestedScope: scope, sessionId })
          : cloudSyncAuthFromPrototypeAuthState({ ...authState, requestedScope: scope }),
    }),
    onConnectionLost,
  });
  const statusSubscription = onStatus
    ? transport.connectionStatus$.subscribe((status) => onStatus(status))
    : null;
  let roomReadySubscription: { unsubscribe(): void } | null = null;
  let handle: MarkdownHandle | null = null;
  let disposed = false;
  let peerId: string | null = null;
  let actorLabel: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let persistence: MarkdownPersistence | null = null;

  const publishSnapshot = () => {
    if (!handle) {
      return;
    }
    onSnapshot({
      body: handle.body() ?? "",
      bodyReady: handle.body_len() != null,
      title: handle.title()?.trim() || title,
    });
  };

  const saveNow = async () => {
    if (!handle || !persistence) {
      return;
    }
    try {
      await persistence.save(handle.save());
    } catch (error) {
      onError?.(error);
    }
  };

  const scheduleSave = () => {
    if (!persistence || disposed) {
      return;
    }
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveNow();
    }, MARKDOWN_PERSISTENCE_SAVE_DELAY_MS);
  };

  const flush = () => {
    if (!handle) {
      return;
    }
    const message = handle.flush_local_changes();
    if (!message) {
      return;
    }
    transport.sendFrame(FrameType.AUTOMERGE_SYNC, message).catch((error: unknown) => {
      handle?.cancel_last_flush();
      onError?.(error);
    });
  };

  const editTitle = (nextTitle: string) => {
    if (!handle) {
      return;
    }
    const normalizedTitle = nextTitle.trim() || "Untitled Markdown";
    if ((handle.title()?.trim() || "Untitled Markdown") === normalizedTitle) {
      return;
    }
    try {
      handle.set_title(normalizedTitle);
      publishSnapshot();
      scheduleSave();
      flush();
    } catch (error) {
      onError?.(error);
    }
  };

  const applyRoomReady = (ready: CloudRoomReady) => {
    if (!handle || ready.peer_id === peerId) {
      return;
    }
    peerId = ready.peer_id;
    actorLabel = ready.actor_label;
    handle.set_actor(ready.actor_label);
    handle.reset_sync_state();
    flush();
  };

  try {
    const ready = await transport.ready;
    peerId = ready.peer_id;
    actorLabel = ready.actor_label;
    const principal = cloudPrincipalFromActorLabel(ready.actor_label);
    persistence = createMarkdownPersistence(config.documentId, principal, onError);
    const seed = await persistence?.load();
    const moduleUrl = new URL(config.runtimedWasmModulePath, location.href);
    const wasmUrl = new URL(config.runtimedWasmPath, location.href);
    handle = seed
      ? await loadMarkdownHandleFromBytes(seed, ready.actor_label, moduleUrl, wasmUrl)
      : await createBootstrapMarkdownHandle(ready.actor_label, moduleUrl, wasmUrl);
    if (disposed) {
      handle.free();
      handle = null;
      transport.disconnect();
      throw new Error("Markdown live sync disposed before ready");
    }
    if (scope !== "viewer") {
      editTitle(title);
    }
    publishSnapshot();
    roomReadySubscription = transport.roomReady$.subscribe(applyRoomReady);
    transport.onFrame((frame) => {
      if (!handle) {
        return;
      }
      const events = handle.receive_frame(new Uint8Array(frame)) as Array<{
        type: string;
        changed?: boolean;
        reply?: number[];
      }> | null;
      if (!Array.isArray(events)) {
        return;
      }
      let changed = false;
      for (const event of events) {
        if (event.reply) {
          transport
            .sendFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array(event.reply))
            .catch((error: unknown) => {
              handle?.cancel_last_flush();
              onError?.(error);
            });
        }
        if (event.changed) {
          changed = true;
        }
      }
      if (changed) {
        publishSnapshot();
        scheduleSave();
      }
    });
    flush();
    return {
      get actorLabel() {
        return actorLabel ?? "";
      },
      get peerId() {
        return peerId ?? "";
      },
      transport,
      editBody: (nextBody) => {
        if (!handle || handle.body_len() == null) {
          return;
        }
        const previousBody = handle.body() ?? "";
        const splice = diffAsSplice(previousBody, nextBody);
        handle.splice_body(splice.index, splice.deleteCount, splice.insertText);
        publishSnapshot();
        scheduleSave();
        flush();
      },
      editTitle,
      flushNow: async () => {
        if (saveTimer !== null) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        await saveNow();
      },
      publishSnapshot: async () => {
        if (!handle) {
          throw new Error("Markdown document is not ready to publish");
        }
        flush();
        if (saveTimer !== null) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        const snapshotBytes = handle.save();
        await saveNow();
        const headsHash = await markdownHeadsDigest(handle.get_heads_hex());
        const response = await fetchWithCloudPrototypeAuth(
          markdownSnapshotEndpoint(config.snapshotBasePath, headsHash),
          {
            method: "PUT",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/octet-stream",
            },
            body: snapshotBytes,
          },
          authState.mode === "dev" ? { ...authState, requestedScope: "owner" } : authState,
        );
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to publish Markdown document");
        }
        const body = (await response.json()) as { revision_id?: unknown };
        if (typeof body.revision_id !== "string" || body.revision_id.trim() === "") {
          throw new Error("Markdown publish response did not include a revision id");
        }
        return {
          headsHash,
          revisionId: body.revision_id,
        };
      },
      dispose: () => {
        disposed = true;
        statusSubscription?.unsubscribe();
        roomReadySubscription?.unsubscribe();
        if (saveTimer !== null) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        void saveNow();
        transport.disconnect();
        handle?.free();
        handle = null;
      },
    };
  } catch (error) {
    statusSubscription?.unsubscribe();
    transport.disconnect();
    handle?.free();
    throw error;
  }
}

interface MarkdownPersistence {
  load(): Promise<Uint8Array | undefined>;
  save(bytes: Uint8Array): Promise<void>;
}

function createMarkdownPersistence(
  documentId: string,
  principal: string,
  onError?: (error: unknown) => void,
): MarkdownPersistence | null {
  const adapter = IndexedDbStorageAdapter.create({ onError });
  if (!adapter) {
    return null;
  }
  const key = markdownPersistenceKey(documentId, principal);
  return {
    load: () => adapter.load(key),
    save: (bytes) => adapter.save(key, bytes),
  };
}

function markdownPersistenceKey(documentId: string, principal: string): string[] {
  return [
    MARKDOWN_PERSISTENCE_KEY_SEGMENT,
    documentId,
    principal,
    MARKDOWN_PERSISTENCE_SNAPSHOT_SEGMENT,
  ];
}

export function selectMarkdownInstantPaintRecord(
  records: readonly StorageChunk[],
  matchesPrincipal: (principal: string) => boolean,
): Uint8Array | undefined {
  return records.find((record) => isMatchingMarkdownPersistenceRecord(record, matchesPrincipal))
    ?.data;
}

function isMatchingMarkdownPersistenceRecord(
  record: StorageChunk,
  matchesPrincipal: (principal: string) => boolean,
): boolean {
  const [kind, documentId, principal, segment, ...extra] = record.key;
  return (
    kind === MARKDOWN_PERSISTENCE_KEY_SEGMENT &&
    typeof documentId === "string" &&
    typeof principal === "string" &&
    segment === MARKDOWN_PERSISTENCE_SNAPSHOT_SEGMENT &&
    extra.length === 0 &&
    Boolean(record.data) &&
    matchesPrincipal(principal)
  );
}

function markdownSnapshotEndpoint(basePath: string, headsHash: string): string {
  const normalizedBasePath = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return `${normalizedBasePath}${encodeURIComponent(headsHash)}`;
}

async function markdownHeadsDigest(heads: string[]): Promise<string> {
  const input = heads.length > 0 ? [...heads].sort().join("\n") : "empty";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return `heads-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24)}`;
}

function diffAsSplice(
  previous: string,
  next: string,
): {
  index: number;
  deleteCount: number;
  insertText: string;
} {
  if (previous === next) {
    return { index: previous.length, deleteCount: 0, insertText: "" };
  }
  let prefix = 0;
  const minLength = Math.min(previous.length, next.length);
  while (prefix < minLength && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  let previousSuffix = previous.length;
  let nextSuffix = next.length;
  while (
    previousSuffix > prefix &&
    nextSuffix > prefix &&
    previous[previousSuffix - 1] === next[nextSuffix - 1]
  ) {
    previousSuffix -= 1;
    nextSuffix -= 1;
  }
  return {
    index: utf16Length(previous.slice(0, prefix)),
    deleteCount: utf16Length(previous.slice(prefix, previousSuffix)),
    insertText: next.slice(prefix, nextSuffix),
  };
}

function utf16Length(value: string): number {
  return value.length;
}
