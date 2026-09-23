// The room publishes idle state before the provider's orphan-session sweep.
// A grace interval avoids expiring a healthy interpreter while the room still
// advertises it as ready. The provider sweep is a fallback if room cleanup fails.
export const CLOUD_RUNTIME_IDLE_MS = 30 * 60_000;
export const PROVIDER_ORPHAN_IDLE_MS = CLOUD_RUNTIME_IDLE_MS + 5 * 60_000;
