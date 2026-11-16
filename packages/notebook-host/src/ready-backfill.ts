import type { DaemonReadyPayload, Unlisten } from "./types";

/** A cached bootstrap cannot supersede any subsequent lifecycle event. */
export function subscribeReadyWithBackfill(
  options: {
    live: (cb: (payload: DaemonReadyPayload) => void) => Unlisten;
    disconnected: (cb: () => void) => Unlisten;
    unavailable: (cb: () => void) => Unlisten;
    cached: () => Promise<DaemonReadyPayload | null>;
  },
  callback: (payload: DaemonReadyPayload) => void,
): Unlisten {
  let active = true;
  let backfillCurrent = true;
  const invalidate = () => {
    backfillCurrent = false;
  };
  const unlisten = [
    options.disconnected(invalidate),
    options.unavailable(invalidate),
    options.live((payload) => {
      invalidate();
      if (active) callback(payload);
    }),
  ];
  void options
    .cached()
    .then((payload) => {
      if (active && backfillCurrent && payload) callback(payload);
    })
    .catch(() => {});
  return () => {
    active = false;
    for (const stop of unlisten) stop();
  };
}
