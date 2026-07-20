const STALE_DEPLOYMENT_RECOVERY_KEY = "nteract:cloud:stale-deployment-recovery";
const STALE_DEPLOYMENT_RECOVERY_COOLDOWN_MS = 60_000;

interface StaleDeploymentRecoveryOptions {
  target?: EventTarget;
  storage?: Pick<Storage, "getItem" | "setItem">;
  reload?: () => void;
  now?: () => number;
  warn?: (message: string, error: unknown) => void;
}

interface StaleDeploymentRecoveryAttempt {
  attemptedAt: number;
  message: string;
}

/**
 * Vite emits `vite:preloadError` when a lazy import or one of its preloaded
 * dependencies cannot be fetched. A tab left open across a deployment can
 * retain the old entry module in memory after its content-hashed lazy chunks
 * have been retired. The deployed host serves notebook HTML with `no-store`
 * and the stable viewer entrypoint with revalidation semantics, so reloading
 * picks up the current asset graph.
 *
 * Keep the attempt in sessionStorage across the reload. If the new deployment
 * is itself broken, a second preload failure inside the cooldown falls through
 * to the root error boundary instead of creating a reload loop.
 */
export function installStaleDeploymentRecovery(
  options: StaleDeploymentRecoveryOptions = {},
): () => void {
  const target = options.target ?? window;
  const storage = options.storage ?? window.sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? (() => Date.now());
  const warn =
    options.warn ??
    ((message: string, error: unknown) => {
      console.warn(message, error);
    });

  const onPreloadError = (event: Event) => {
    const error = preloadErrorPayload(event);
    if (!claimStaleDeploymentRecovery(storage, now(), error)) {
      return;
    }

    event.preventDefault();
    warn("[notebook-cloud] stale deployment asset detected; reloading viewer", error);
    reload();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}

function claimStaleDeploymentRecovery(
  storage: Pick<Storage, "getItem" | "setItem">,
  attemptedAt: number,
  error: unknown,
): boolean {
  try {
    const previous = parseRecoveryAttempt(storage.getItem(STALE_DEPLOYMENT_RECOVERY_KEY));
    // The boundary is intentionally exclusive: a new recovery may run once
    // the full cooldown duration has elapsed.
    if (
      previous &&
      attemptedAt >= previous.attemptedAt &&
      attemptedAt - previous.attemptedAt < STALE_DEPLOYMENT_RECOVERY_COOLDOWN_MS
    ) {
      return false;
    }

    const attempt: StaleDeploymentRecoveryAttempt = {
      attemptedAt,
      message: error instanceof Error ? error.message : String(error),
    };
    storage.setItem(STALE_DEPLOYMENT_RECOVERY_KEY, JSON.stringify(attempt));
    return true;
  } catch {
    // Without durable loop protection, leave the failure to the error boundary.
    return false;
  }
}

function parseRecoveryAttempt(value: string | null): StaleDeploymentRecoveryAttempt | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<StaleDeploymentRecoveryAttempt>;
    return typeof parsed.attemptedAt === "number" &&
      Number.isFinite(parsed.attemptedAt) &&
      typeof parsed.message === "string"
      ? { attemptedAt: parsed.attemptedAt, message: parsed.message }
      : null;
  } catch {
    return null;
  }
}

function preloadErrorPayload(event: Event): unknown {
  return "payload" in event ? (event as Event & { payload: unknown }).payload : event;
}
