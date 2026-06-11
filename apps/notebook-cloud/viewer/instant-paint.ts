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

import type { PersistedNotebookDoc } from "runtimed";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import { isAnonymousCloudPrincipal, withReadyTimeout } from "./live-sync";

/**
 * Bound on the instant-paint IndexedDB reads. A hung IDB open must
 * degrade to no-paint; the live room is dialing in parallel regardless.
 */
const INSTANT_PAINT_READ_TIMEOUT_MS = 2_000;

const DEV_PRINCIPAL_PREFIX = "user:dev:";

/**
 * Mirrors the worker's `principalForDevUser` (src/identity.ts):
 * `user:dev:<encodePrincipalComponent(user)>`, where the encoder is
 * `encodeURIComponent`.
 */
function devPrincipalForUser(user: string): string {
  return `${DEV_PRINCIPAL_PREFIX}${encodeURIComponent(user.trim() || "browser-editor")}`;
}

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
    const expected = devPrincipalForUser(authState.user ?? "browser-editor");
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
   * Race guard: re-checked after every await. A live materialization that
   * wins the race against the cache read flips this to false and the
   * paint is skipped — stale cache must never overwrite live pixels.
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
