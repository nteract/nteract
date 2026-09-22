import type { CloudAppSession } from "./app-session";

export interface CloudAppSessionViewState {
  status: "loading" | "ready" | "error";
  session: CloudAppSession | null;
  error: string | null;
}

export function cloudAppSessionsEqual(
  a: CloudAppSession | null,
  b: CloudAppSession | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    a.expires_at === b.expires_at &&
    a.cache_key === b.cache_key &&
    a.display_name === b.display_name
  );
}

const _CLOUD_APP_SESSION_FIELDS = {
  provider: true,
  expires_at: true,
  cache_key: true,
  display_name: true,
} satisfies Record<keyof CloudAppSession, true>;
void _CLOUD_APP_SESSION_FIELDS;
