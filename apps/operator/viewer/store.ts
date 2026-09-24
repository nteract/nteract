import { interval, type SchedulerLike, type Subscription } from "rxjs";
import { ObservableStore } from "runtimed/src/observable-store.ts";
import { isMetrics, type Metrics } from "./metrics.ts";

interface State {
  phase: "loading" | "signing-out" | "signed-out" | "denied" | "ready" | "error";
  data: Metrics | null;
  dataHours: number;
  message: string;
  refreshing: boolean;
}
export class OperatorStore extends ObservableStore<State> {
  private pending?: AbortController;
  private generation = 0;
  private timer?: Subscription;
  private hours = 24;
  private signedOut = false;
  constructor(private readonly network: typeof fetch = (input, init) => fetch(input, init)) {
    super({ phase: "loading", data: null, dataHours: 24, message: "", refreshing: false });
  }
  readonly subscribe = (notify: () => void) => {
    const sub = this.state$.subscribe(notify);
    return () => sub.unsubscribe();
  };
  readonly getSnapshot = () => this.snapshot;
  start(scheduler?: SchedulerLike) {
    this.timer?.unsubscribe();
    void this.refresh();
    this.timer = interval(60_000, scheduler).subscribe(() => {
      void this.refresh();
    });
    return () => this.dispose();
  }
  setHours(hours: number) {
    this.hours = hours;
    void this.refresh();
  }
  async refresh() {
    if (this.signedOut) return;
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    const generation = ++this.generation;
    const hours = this.hours;
    const current = () => generation === this.generation;
    this.setState({ ...this.snapshot, refreshing: true });
    try {
      const init = {
        cache: "no-store" as const,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      };
      const session = await this.network("/api/operator/session", init);
      if (!current()) return;
      if (session.status === 401 || session.status === 403) {
        this.setState({
          ...this.snapshot,
          phase: session.status === 401 ? "signed-out" : "denied",
          data: null,
          message: "",
          refreshing: false,
        });
        return;
      }
      if (!session.ok) throw new Error("Sign-in service unavailable. Try refreshing.");
      const response = await this.network(`/api/operator/metrics?hours=${hours}`, init);
      if (response.status === 401 || response.status === 403) {
        if (current())
          this.setState({
            ...this.snapshot,
            phase: response.status === 403 ? "denied" : "signed-out",
            data: null,
            message: "",
            refreshing: false,
          });
        return;
      }
      if (!response.ok) throw new Error("Metrics unavailable. Retained measurements are stale.");
      const data: unknown = await response.json();
      if (!isMetrics(data)) throw new Error("Unsupported metrics response.");
      if (current())
        this.setState({ phase: "ready", data, dataHours: hours, message: "", refreshing: false });
    } catch (error) {
      if (current())
        this.setState({
          ...this.snapshot,
          phase: "error",
          data: this.snapshot.data ? { ...this.snapshot.data, stale: true } : null,
          message: error instanceof Error ? error.message : "Service unavailable",
          refreshing: false,
        });
    }
  }
  async signOut() {
    this.signedOut = true;
    this.timer?.unsubscribe();
    this.pending?.abort();
    const generation = ++this.generation;
    this.setState({
      ...this.snapshot,
      phase: "signing-out",
      data: null,
      message: "",
      refreshing: false,
    });
    try {
      const response = await this.network("/api/operator/session", {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error();
      if (generation === this.generation)
        this.setState({ ...this.snapshot, phase: "signed-out", data: null });
    } catch {
      if (generation !== this.generation) return;
      this.setState({
        ...this.snapshot,
        phase: "error",
        data: null,
        message: "Sign-out could not be confirmed. Try again.",
        refreshing: false,
      });
    }
  }
  dispose() {
    this.timer?.unsubscribe();
    this.pending?.abort();
    ++this.generation;
  }
}
