import { useEffect } from "react";
import type { OfflineMergeNoticeData } from "./offline-merge-tracker";

/**
 * How long the offline-merge notice stays up with no user action. It is a
 * confirmation, not a warning — it must never demand a dismissal.
 */
export const OFFLINE_MERGE_NOTICE_TIMEOUT_MS = 10_000;

/**
 * Clear the offline-merge notice on the next user action (any pointer or
 * key input — the user has moved on) or after a short timeout. Listeners
 * are capture-phase so a click consumed by an editor still clears it, and
 * everything is torn down when the notice clears or the host unmounts.
 */
export function useOfflineMergeNoticeAutoClear(
  notice: OfflineMergeNoticeData | null,
  clear: () => void,
  timeoutMs: number = OFFLINE_MERGE_NOTICE_TIMEOUT_MS,
): void {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clear, timeoutMs);
    const onUserAction = () => clear();
    window.addEventListener("pointerdown", onUserAction, { capture: true });
    window.addEventListener("keydown", onUserAction, { capture: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", onUserAction, { capture: true });
      window.removeEventListener("keydown", onUserAction, { capture: true });
    };
  }, [notice, clear, timeoutMs]);
}
