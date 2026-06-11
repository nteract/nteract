/**
 * Instant first paint from the persisted snapshot (cloud, live-room path).
 *
 * Page load paints the notebook immediately from the local envelope
 * records instead of waiting for the WS dial + cloud_room_ready + full
 * bootstrap sync: NotebookDoc bytes plus the render-only RuntimeStateDoc
 * cache decode into a THROWAWAY render handle (the pinned-snapshot path's
 * exact shape) that is materialized once and freed. Painting needs no
 * actor and no connection; the syncing handle is still seeded separately,
 * after the handshake, by `resolveCloudNotebookHandle`.
 *
 * Pre-handshake principal gate: before cloud_room_ready we do not know
 * the connection's principal, and IndexedDB may hold another user's
 * notebook on a shared machine. The paint is gated on a principal
 * MATCHER derived from locally stored auth material — the dev-token user
 * (exact principal, mirroring `principalForDevUser`) or the stored OIDC
 * subject claim (the principal's id segment; the namespace prefix is
 * server-configured and not client-derivable). No derivable principal ⇒
 * no paint — wait for the room.
 *
 * Clearing discipline: a mismatched principal on either record skips the
 * paint WITHOUT clearing — post-handshake seeding owns that decision. The
 * only clears here target the render-only cache record, and only when the
 * cache itself is unusable (torn envelope, `load_snapshot` rejecting its
 * bytes) — never on transient WASM asset failures, and never the
 * NotebookDoc seed record (which may hold offline edits).
 */

import {
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  clearPersistedNotebookRecord,
  loadPersistedNotebookDoc,
  loadPersistedNotebookRecord,
  type PersistedNotebookDoc,
  type StorageAdapter,
} from "runtimed";
import { devPrincipalLabel, type CloudPrototypeAuthState } from "./collaborator-auth";
import { isAnonymousCloudPrincipal, withReadyTimeout } from "./live-sync";

/**
 * Bound on the instant-paint IndexedDB reads. A hung IDB open must
 * degrade to no-paint; the live room is dialing in parallel regardless.
 */
const INSTANT_PAINT_READ_TIMEOUT_MS = 2_000;

const DEV_PRINCIPAL_PREFIX = "user:dev:";

/**
 * Derive a principal matcher from locally stored auth material, WITHOUT
 * the room handshake. Returns null when no principal is derivable — the
 * caller must then skip the paint entirely.
 *
 * - Dev token: the worker derives the principal deterministically from
 *   the presented user, so an exact match is available.
 * - OIDC (valid stored token, or expired claims backed by a live
 *   app-session cookie — the cookie was minted from that subject's
 *   token): the worker's principal is `<namespace>:<encoded sub>` with a
 *   server-configured namespace, so the matcher pins the encoded subject
 *   as the principal's id segment and rejects the namespaces it cannot
 *   belong to (anonymous, dev).
 *
 * Anonymous principals never match any matcher: they are per-connection
 * nonces and persisted records are never written for them anyway.
 */
export function cloudInstantPaintPrincipalMatcher(
  authState: CloudPrototypeAuthState,
  options: { hasAppSession?: boolean } = {},
): ((principal: string) => boolean) | null {
  if (authState.mode === "dev" && authState.token) {
    const expected = devPrincipalLabel(authState.user ?? "browser-editor");
    return (principal) => !isAnonymousCloudPrincipal(principal) && principal === expected;
  }

  const sub = authState.oidcClaims?.sub?.trim();
  const oidcUsable =
    authState.mode === "oidc" ||
    (authState.mode === "oidc_expired" && options.hasAppSession === true);
  if (oidcUsable && sub) {
    const encodedSub = encodeURIComponent(sub);
    return (principal) =>
      !isAnonymousCloudPrincipal(principal) &&
      !principal.startsWith(DEV_PRINCIPAL_PREFIX) &&
      principal.endsWith(`:${encodedSub}`);
  }

  return null;
}

/**
 * Zero-cell displacement policy for the live materialization path.
 *
 * An empty SYNCING handle usually means the bootstrap exchange has not
 * delivered the room's content yet, and applying it would blank a painted
 * (instant paint) or preserved notebook — so a zero-cell materialization
 * is skipped while cells are showing. But once the handle has provably
 * caught up to the room's advertised heads, zero cells IS the room's
 * truth: live emptiness must displace whatever is showing. This is the
 * principal-matcher heuristic's backstop — a false-positive paint must
 * not outlive the handshake, even over a room with nothing to send. With
 * nothing painted, the empty state may always show once the pinned
 * snapshot path has resolved.
 */
export function shouldDisplayEmptyLiveNotebook({
  snapshotResolved,
  paintedCellCount,
  handleCaughtUp,
}: {
  snapshotResolved: boolean;
  paintedCellCount: number;
  handleCaughtUp: boolean;
}): boolean {
  if (!snapshotResolved) return false;
  return paintedCellCount === 0 || handleCaughtUp;
}

/**
 * `notebook_doc_caught_up()` with deployed-handle tolerance: an older WASM
 * bundle without the export reports not-caught-up, degrading to the
 * previous behavior (painted cells are never displaced by emptiness).
 */
export function cloudNotebookHandleCaughtUp(handle: {
  notebook_doc_caught_up?: () => boolean;
}): boolean {
  try {
    return handle.notebook_doc_caught_up?.() ?? false;
  } catch {
    return false;
  }
}

export type CloudInstantPaintOutcome =
  | "painted"
  | "painted_cells_only"
  | "skipped_no_principal"
  | "skipped_no_record"
  | "skipped_principal_mismatch"
  | "skipped_read_failed"
  | "skipped_superseded"
  | "skipped_unloadable";

export interface ResolvedCloudInstantPaint<Handle> {
  /** Throwaway render handle; the caller must free it after materialization. */
  handle: Handle | null;
  outcome: CloudInstantPaintOutcome;
}

export interface CloudInstantPaintOptions<Handle> {
  /** From `cloudInstantPaintPrincipalMatcher`; null skips the paint. */
  matchesPrincipal: ((principal: string) => boolean) | null;
  loadNotebookRecord: () => Promise<PersistedNotebookDoc | undefined>;
  loadRuntimeStateCacheRecord: () => Promise<PersistedNotebookDoc | undefined>;
  /** Discards ONLY the render cache record; the seed record never clears here. */
  clearRuntimeStateCacheRecord: () => Promise<void>;
  loadRenderHandle: (
    notebookBytes: Uint8Array,
    runtimeStateBytes: Uint8Array | undefined,
  ) => Promise<Handle>;
  /**
   * Race guard: re-checked after every await that precedes a paintable
   * decision or a destructive step (the cache-record clear). A handle may
   * still be returned after a late flip — callers must re-check before
   * materializing and must always free the handle. A live materialization
   * that wins the race flips this to false and the paint is skipped —
   * stale cache must never overwrite live pixels, and a stale ATTEMPT
   * must never clear a record the live session may have just rewritten.
   */
  shouldContinue?: () => boolean;
  /**
   * True for failures that do NOT incriminate the cached bytes (WASM
   * asset load failures). Those skip the cells-only retry and never clear
   * the cache record.
   */
  isTransientLoadFailure?: (error: unknown) => boolean;
  readTimeoutMs?: number;
}

/**
 * Resolve the throwaway render handle for an instant first paint, or the
 * reason there is nothing to paint. Mirrors `resolveCloudNotebookHandle`'s
 * dependency-injected shape so every branch is testable without WASM.
 */
export async function resolveCloudInstantPaintHandle<Handle>({
  matchesPrincipal,
  loadNotebookRecord,
  loadRuntimeStateCacheRecord,
  clearRuntimeStateCacheRecord,
  loadRenderHandle,
  shouldContinue = () => true,
  isTransientLoadFailure = () => false,
  readTimeoutMs = INSTANT_PAINT_READ_TIMEOUT_MS,
}: CloudInstantPaintOptions<Handle>): Promise<ResolvedCloudInstantPaint<Handle>> {
  if (!matchesPrincipal) {
    return { handle: null, outcome: "skipped_no_principal" };
  }

  let notebookRecord: PersistedNotebookDoc | undefined;
  let cacheRecord: PersistedNotebookDoc | undefined;
  try {
    [notebookRecord, cacheRecord] = await withReadyTimeout(
      Promise.all([loadNotebookRecord(), loadRuntimeStateCacheRecord()]),
      readTimeoutMs,
      `instant-paint record read did not settle within ${readTimeoutMs}ms`,
    );
  } catch (error) {
    // Fail-open reads stay fail-closed for clears: leave both records be.
    console.warn("[notebook-cloud] instant-paint record read failed; skipping paint", error);
    return { handle: null, outcome: "skipped_read_failed" };
  }
  if (!shouldContinue()) {
    return { handle: null, outcome: "skipped_superseded" };
  }

  if (!notebookRecord?.meta || !notebookRecord.bytes) {
    // Absent or unverifiable seed record: nothing paintable. Seeding's
    // post-handshake logic owns whether an unverifiable record clears.
    return { handle: null, outcome: "skipped_no_record" };
  }
  if (!matchesPrincipal(notebookRecord.meta.principal)) {
    return { handle: null, outcome: "skipped_principal_mismatch" };
  }

  let runtimeStateBytes: Uint8Array | undefined;
  if (cacheRecord) {
    if (cacheRecord.meta && cacheRecord.bytes) {
      if (!matchesPrincipal(cacheRecord.meta.principal)) {
        // Verifiably someone else's pixels: skip the whole paint. No
        // clear — seeding's principal logic owns the discard decision.
        return { handle: null, outcome: "skipped_principal_mismatch" };
      }
      runtimeStateBytes = cacheRecord.bytes;
    } else {
      // Torn/unverifiable cache record: render-only garbage. Discard it
      // (the seed record is untouched) and degrade to cells-only.
      await clearCacheRecord(clearRuntimeStateCacheRecord);
    }
  }

  try {
    const handle = await loadRenderHandle(notebookRecord.bytes, runtimeStateBytes);
    return { handle, outcome: runtimeStateBytes ? "painted" : "painted_cells_only" };
  } catch (error) {
    if (runtimeStateBytes && !isTransientLoadFailure(error)) {
      // Seconds can elapse inside loadRenderHandle (the WASM init ladder),
      // and the clear decision was made against the OLD bytes: a stale
      // attempt must not delete a fresh record the live session's save
      // loop may have just written under the same key.
      if (!shouldContinue()) {
        return { handle: null, outcome: "skipped_superseded" };
      }
      // load_snapshot rejected with cache bytes in play: treat the cache
      // as corrupt, clear ONLY that record, and retry cells-only — the
      // notebook envelope may be fine.
      console.warn(
        "[notebook-cloud] instant-paint snapshot load failed; clearing runtime-state cache and retrying cells-only",
        error,
      );
      await clearCacheRecord(clearRuntimeStateCacheRecord);
      if (!shouldContinue()) {
        return { handle: null, outcome: "skipped_superseded" };
      }
      try {
        const handle = await loadRenderHandle(notebookRecord.bytes, undefined);
        return { handle, outcome: "painted_cells_only" };
      } catch (cellsOnlyError) {
        console.warn(
          "[notebook-cloud] instant-paint cells-only load failed; skipping paint",
          cellsOnlyError,
        );
        return { handle: null, outcome: "skipped_unloadable" };
      }
    }
    // Corrupt notebook bytes degrade to no-paint without clearing: the
    // seed record may hold offline edits and post-handshake seeding owns
    // its corruption handling. Transient asset failures clear nothing.
    console.warn("[notebook-cloud] instant-paint load failed; skipping paint", error);
    return { handle: null, outcome: "skipped_unloadable" };
  }
}

async function clearCacheRecord(clear: () => Promise<void>): Promise<void> {
  try {
    await clear();
  } catch (error) {
    console.warn("[notebook-cloud] failed to clear runtime-state cache record", error);
  }
}

/**
 * The instant paint's storage bindings: which record each resolver
 * dependency reads, and — load-bearing — that the corrupt-cache clear
 * targets ONLY `[notebookId, "runtime-state-cache"]`. The NotebookDoc
 * seed record may hold the only copy of offline edits; a paint-side
 * clear must never be able to touch it. Built here (not inline in the
 * session) so the binding is testable against a real adapter.
 */
export function cloudInstantPaintStorageOptions(
  adapter: StorageAdapter,
  notebookId: string,
): Pick<
  CloudInstantPaintOptions<never>,
  "loadNotebookRecord" | "loadRuntimeStateCacheRecord" | "clearRuntimeStateCacheRecord"
> {
  return {
    loadNotebookRecord: () => loadPersistedNotebookDoc(adapter, notebookId),
    loadRuntimeStateCacheRecord: () =>
      loadPersistedNotebookRecord(adapter, notebookId, RUNTIME_STATE_CACHE_KEY_SEGMENT),
    clearRuntimeStateCacheRecord: () =>
      clearPersistedNotebookRecord(adapter, notebookId, RUNTIME_STATE_CACHE_KEY_SEGMENT),
  };
}

export type CloudInstantPaintRunOutcome = CloudInstantPaintOutcome | "skipped_empty_snapshot";

export interface CloudInstantPaintRunOptions<Handle, Materialized extends { cells: unknown[] }> {
  /** Typically `resolveCloudInstantPaintHandle` — yields the throwaway handle. */
  resolveHandle: () => Promise<ResolvedCloudInstantPaint<Handle>>;
  /**
   * The freshness flag (`!disposed && !liveMaterialized`). Re-checked here
   * after EVERY await: a live materialization that lands first — or while
   * the cache decodes, materializes, or projects widgets — wins, and no
   * later step applies stale cache over it.
   */
  isFresh: () => boolean;
  /**
   * Progressive materialization of the render handle. Receives the
   * freshness flag for its progressive-apply callbacks (`shouldContinue`).
   */
  materialize: (handle: Handle, shouldContinue: () => boolean) => Promise<Materialized>;
  /** Synchronous adoption of notebook language + metadata. */
  acceptMetadata: (materialized: Materialized) => void;
  /** Async widget-comm projection; receives the freshness flag. */
  projectWidgets: (materialized: Materialized, shouldContinue: () => boolean) => Promise<void>;
  /** Final wholesale apply + status + milestone. Only invoked while fresh. */
  applyPaint: (materialized: Materialized) => void;
  /** Free the throwaway handle; runs whenever a handle was resolved. */
  freeHandle: (handle: Handle) => void;
}

/**
 * Drive one instant-paint attempt end to end: resolve the throwaway
 * handle, materialize it, project widget comms, apply the final cells —
 * with the freshness re-check between every step and the handle freed on
 * every exit path. The session injects its store/status effects; the
 * sequencing and the race guard live here, under test.
 */
export async function runCloudInstantPaint<Handle, Materialized extends { cells: unknown[] }>({
  resolveHandle,
  isFresh,
  materialize,
  acceptMetadata,
  projectWidgets,
  applyPaint,
  freeHandle,
}: CloudInstantPaintRunOptions<Handle, Materialized>): Promise<CloudInstantPaintRunOutcome> {
  const resolved = await resolveHandle();
  const handle = resolved.handle;
  if (handle === null) {
    return resolved.outcome;
  }
  try {
    if (!isFresh()) {
      return "skipped_superseded";
    }
    const materialized = await materialize(handle, isFresh);
    if (!isFresh()) {
      return "skipped_superseded";
    }
    if (materialized.cells.length === 0) {
      // An empty persisted snapshot paints nothing: the room decides what
      // an empty notebook means.
      return "skipped_empty_snapshot";
    }
    acceptMetadata(materialized);
    await projectWidgets(materialized, isFresh);
    if (!isFresh()) {
      return "skipped_superseded";
    }
    applyPaint(materialized);
    return resolved.outcome;
  } finally {
    freeHandle(handle);
  }
}
