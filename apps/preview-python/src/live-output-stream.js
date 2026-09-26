import { filter, mergeMap, scan, takeLast, takeWhile, windowTime } from "rxjs";

/** Bounded advisory stream windows; the scheduler is injected for marble tests. */
export function liveOutputBatches(events$, { intervalMs = 150, maxPending = 256, scheduler } = {}) {
  const append = (batch, event) => {
    if (event.type === "live_stopped") return { events: [], stopped: true };
    const events = batch.events;
    const last = events.at(-1);
    if (event.type === "stream") {
      if (last?.type === "stream" && last.name === event.name) last.text += event.text;
      else events.push({ type: "stream", name: event.name, text: event.text });
    } else if (event.type === "boundary") {
      if (last?.type !== "boundary") events.push({ type: "boundary" });
    } else if (event.type === "clear") {
      events.push({ type: "clear", wait: event.wait === true });
    }
    return events.length > maxPending ? { events: [], stopped: true } : batch;
  };
  return events$.pipe(
    windowTime(intervalMs, scheduler),
    mergeMap((window$) =>
      window$.pipe(
        scan(append, { events: [], stopped: false }),
        takeWhile((batch) => !batch.stopped, true),
        takeLast(1),
      ),
    ),
    filter((batch) => batch.stopped || batch.events.length > 0),
    // Overflow or the upstream byte cap stops all subsequent live windows.
    takeWhile((batch) => !batch.stopped, true),
  );
}
