import { useEffect, useState } from "react";
import type { ConnectionStatus } from "runtimed";

/**
 * How long the live room must stay in "reconnecting" before the notices
 * stack says so. Transient blips (a dropped socket that recovers on the
 * first retry) resolve well inside this window and surface nothing.
 */
export const SUSTAINED_RECONNECTING_DEBOUNCE_MS = 3_000;

/** Structural slice of `CloudConnectionStatusBridge` the hook consumes. */
export interface ReconnectingStatusSource {
  subscribe(next: (status: ConnectionStatus) => void): { unsubscribe(): void };
}

/**
 * Debounce "reconnecting" into a single sustained flag:
 *
 * - `reconnecting` arms one timer; the flag flips true only if the status
 *   is STILL reconnecting when the debounce elapses. Repeated reconnecting
 *   deliveries while armed (or already sustained) are no-ops, so flapping
 *   connections cannot spam the notices stack.
 * - `online` (and the terminal manual-disconnect `offline`) cancels the
 *   pending timer and clears the flag.
 * - `connecting` is neutral: a replacement transport reports "connecting"
 *   before its first handshake, and that is neither recovery (the line
 *   must not clear before the room is back) nor a fresh loss.
 */
export class SustainedReconnectingTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sustained = false;

  constructor(
    private readonly options: {
      debounceMs: number;
      onChange: (sustained: boolean) => void;
    },
  ) {}

  next(status: ConnectionStatus): void {
    if (status === "reconnecting") {
      if (this.sustained || this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.sustained = true;
        this.options.onChange(true);
      }, this.options.debounceMs);
      return;
    }
    if (status === "online" || status === "offline") {
      this.clearTimer();
      if (this.sustained) {
        this.sustained = false;
        this.options.onChange(false);
      }
    }
    // "connecting" falls through: neither arms nor clears.
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * True while the live-room connection has been "reconnecting" for at
 * least `debounceMs`. Drives the quiet notices-stack line — the
 * connection/identity slot stays an 8px dot by design, so a sustained
 * outage needs one legible sentence somewhere calm.
 */
export function useSustainedReconnecting(
  source: ReconnectingStatusSource,
  debounceMs: number = SUSTAINED_RECONNECTING_DEBOUNCE_MS,
): boolean {
  const [sustained, setSustained] = useState(false);

  useEffect(() => {
    const tracker = new SustainedReconnectingTracker({ debounceMs, onChange: setSustained });
    const subscription = source.subscribe((status) => tracker.next(status));
    return () => {
      subscription.unsubscribe();
      tracker.dispose();
      setSustained(false);
    };
  }, [source, debounceMs]);

  return sustained;
}
