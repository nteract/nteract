/**
 * Classification for terminal runtimed WASM asset failures.
 *
 * The wasm client prefixes every terminal load/init failure so the notices
 * layer can distinguish "the notebook engine's assets failed to load" from
 * auth/access/transport failures — the former gets a Retry action wired to
 * retryLiveConnection (the documented re-entry; the caches clear on
 * rejection so the retry genuinely re-imports), never the auth-flavored
 * actions. Kept dependency-free so notices.tsx can import the predicate
 * without pulling the WASM client module graph into its tests.
 */

export const RUNTIMED_WASM_ASSET_FAILURE_PREFIX = "runtimed WASM asset failed: ";

export function isRuntimedWasmAssetFailure(message: string): boolean {
  return message.includes(RUNTIMED_WASM_ASSET_FAILURE_PREFIX);
}

export function asRuntimedWasmAssetFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isRuntimedWasmAssetFailure(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`${RUNTIMED_WASM_ASSET_FAILURE_PREFIX}${message}`, { cause: error });
}
