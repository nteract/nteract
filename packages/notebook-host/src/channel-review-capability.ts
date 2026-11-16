import type { HostDaemonEvents, Unlisten } from "./types";

/** Ephemeral UI gate only. The daemon independently authorizes every request. */
export function observeScopedChannelReviewCapability(
  events: HostDaemonEvents,
  explicitUiOptIn: boolean,
  changed: (enabled: boolean) => void,
): Unlisten {
  let active = true;
  let highestGeneration = -1;
  const disable = () => {
    if (active) changed(false);
  };
  disable();
  if (!explicitUiOptIn)
    return () => {
      active = false;
    };
  const stops = [
    events.onDisconnected(disable),
    events.onUnavailable(disable),
    events.onReady((payload) => {
      if (!active) return;
      const generation = payload.relay_generation;
      if (!Number.isSafeInteger(generation) || generation === undefined || generation < 0) {
        disable();
        return;
      }
      // Duplicate or delayed bootstraps cannot restore a disconnected session.
      if (generation <= highestGeneration) return;
      highestGeneration = generation;
      changed(
        payload.scoped_channel_review_v1 === true &&
          payload.connection_scope === "owner" &&
          !payload.hosted_notebook_url,
      );
    }),
  ];
  return () => {
    active = false;
    for (const stop of stops) stop();
  };
}
