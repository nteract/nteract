import { useCallback, useRef, useState } from "react";
import {
  type PoolErrorWithTimestamp,
  type PoolState,
  usePoolState as usePoolStateStore,
} from "../lib/pool-state";

export type { PoolErrorWithTimestamp } from "../lib/pool-state";

type PoolManager = "uv" | "conda" | "pixi";

/** Compare two pool errors for equality (all fields except receivedAt) */
function errorsEqual(
  a: PoolErrorWithTimestamp | null | undefined,
  b: PoolErrorWithTimestamp | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.message === b.message &&
    a.failed_package === b.failed_package &&
    a.error_kind === b.error_kind &&
    a.consecutive_failures === b.consecutive_failures &&
    a.retry_in_secs === b.retry_in_secs
  );
}

/** Extract error info from a RuntimePoolState, or null if healthy. */
function extractError(pool: PoolState[keyof PoolState]): PoolErrorWithTimestamp | null {
  if (!pool.error) return null;
  return {
    message: pool.error,
    failed_package: pool.failed_package,
    error_kind: pool.error_kind,
    consecutive_failures: pool.consecutive_failures,
    retry_in_secs: pool.retry_in_secs,
    receivedAt: Date.now(),
  };
}

function isTransientPoolError(error: PoolErrorWithTimestamp): boolean {
  return error.error_kind === "timeout" || error.error_kind === "setup_failed";
}

function shouldShowErrorForManager(
  manager: PoolManager,
  activeManager: string | null | undefined,
  error: PoolErrorWithTimestamp | null,
): boolean {
  if (!error) return false;
  if (!activeManager || activeManager === manager) return true;

  // Pool warmups run globally. Avoid alerting users about transient retry
  // noise from managers they are not currently using, while still surfacing
  // actionable settings issues like invalid packages.
  return !isTransientPoolError(error);
}

/**
 * Hook that reads pool state from the daemon's PoolDoc (Automerge sync).
 *
 * Reports prewarm pool errors (e.g., typo'd package in default_packages)
 * so the UI can display warnings with retry countdowns.
 */
export function usePoolState(activeManager?: string | null) {
  const poolState = usePoolStateStore();

  // Track dismissed errors so they don't reappear until state changes
  const [dismissedUv, setDismissedUv] = useState(false);
  const [dismissedConda, setDismissedConda] = useState(false);
  const [dismissedPixi, setDismissedPixi] = useState(false);

  // Track previous errors to detect changes and reset dismiss state
  const prevUvErrorRef = useRef<PoolErrorWithTimestamp | null>(null);
  const prevCondaErrorRef = useRef<PoolErrorWithTimestamp | null>(null);
  const prevPixiErrorRef = useRef<PoolErrorWithTimestamp | null>(null);

  const uvError = extractError(poolState.uv);
  const condaError = extractError(poolState.conda);
  const pixiError = extractError(poolState.pixi);

  // Reset dismiss state when error changes
  if (!errorsEqual(uvError, prevUvErrorRef.current)) {
    prevUvErrorRef.current = uvError;
    if (dismissedUv) setDismissedUv(false);
  }
  if (!errorsEqual(condaError, prevCondaErrorRef.current)) {
    prevCondaErrorRef.current = condaError;
    if (dismissedConda) setDismissedConda(false);
  }
  if (!errorsEqual(pixiError, prevPixiErrorRef.current)) {
    prevPixiErrorRef.current = pixiError;
    if (dismissedPixi) setDismissedPixi(false);
  }

  const visibleUvError =
    !dismissedUv && shouldShowErrorForManager("uv", activeManager, uvError) ? uvError : null;
  const visibleCondaError =
    !dismissedConda && shouldShowErrorForManager("conda", activeManager, condaError)
      ? condaError
      : null;
  const visiblePixiError =
    !dismissedPixi && shouldShowErrorForManager("pixi", activeManager, pixiError)
      ? pixiError
      : null;

  const dismissUvError = useCallback(() => {
    setDismissedUv(true);
  }, []);

  const dismissCondaError = useCallback(() => {
    setDismissedConda(true);
  }, []);

  const dismissPixiError = useCallback(() => {
    setDismissedPixi(true);
  }, []);

  const dismissAll = useCallback(() => {
    setDismissedUv(true);
    setDismissedConda(true);
    setDismissedPixi(true);
  }, []);

  return {
    uvError: visibleUvError,
    condaError: visibleCondaError,
    pixiError: visiblePixiError,
    hasErrors: visibleUvError !== null || visibleCondaError !== null || visiblePixiError !== null,
    dismissUvError,
    dismissCondaError,
    dismissPixiError,
    dismissAll,
  };
}
