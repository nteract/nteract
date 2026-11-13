// A chart Worker for tests in a DOM without Workers. Install it with
// viewer/vega-chart.mjs `setChartWorker(() => new InProcessWorker())`.
import { serveCharts } from "../viewer/chart-dataflow.mjs";

/**
 * A Worker that runs the chart Worker's own message loop (serveCharts) in
 * this process, a task later, with structured clones (and transfers)
 * crossing as they would. `workers` counts the Workers charts start, those
 * still running, and the draws they are sent. `workers.hang(message)` marks
 * a draw that hangs: it starts, never answers, and its Worker sends nothing
 * after, as a Worker stuck in a loop. `workers.silent` makes new Workers
 * whose script never runs: no `ready`, no answers. `workers.answered()` runs
 * on this thread right after a Worker queues an answer; `workers.posted` is
 * when the last draw was sent.
 */
export const workers = {
  created: 0,
  live: new Set(),
  draws: 0,
  posted: 0,
  hang: null,
  silent: false,
  answered: null,
};
export class InProcessWorker extends EventTarget {
  constructor() {
    super();
    workers.created++;
    workers.live.add(this);
    this.hangs = new Set();
    this.stuck = false;
    this.scope = new EventTarget();
    // Clone on send, as a real Worker's postMessage does: a value that can't
    // cross throws inside the Worker.
    this.scope.postMessage = (message) => {
      if (this.stuck) return;
      if (message.type === "answer" && this.hangs.has(message.id)) {
        this.stuck = true;
        return;
      }
      const data = structuredClone(message);
      setTimeout(() => {
        if (workers.live.has(this)) this.dispatchEvent(new MessageEvent("message", { data }));
      });
      if (message.type === "answer") workers.answered?.();
    };
    if (!workers.silent) serveCharts(this.scope);
  }
  postMessage(message, transfer = []) {
    if (message.type === "draw") {
      workers.draws++;
      workers.posted = performance.now();
      if (workers.hang?.(message)) this.hangs.add(message.id);
    }
    const data = structuredClone(message, { transfer });
    setTimeout(() => {
      if (workers.live.has(this) && !this.stuck)
        this.scope.dispatchEvent(new MessageEvent("message", { data }));
    });
  }
  terminate() {
    workers.live.delete(this);
  }
}
