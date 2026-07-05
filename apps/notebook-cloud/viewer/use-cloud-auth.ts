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
  return a.provider === b.provider && a.expires_at === b.expires_at && a.cache_key === b.cache_key;
}
