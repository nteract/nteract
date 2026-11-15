import type { SchedulerLike } from "rxjs";

export type OutputState =
  | "connecting"
  | "handshaking"
  | "loading"
  | "importing"
  | "initializing"
  | "rendering"
  | "ready"
  | "failed"
  | "disposed";
export interface OutputAsset {
  bytes: Uint8Array;
  mediaType: string;
  assetId?: string;
}
export interface WidgetDefinition {
  /** Named text/javascript asset containing a standard AFM. */
  _esm: string;
  /** Optional named text/css asset. */
  _css?: string;
  state?: Record<string, unknown>;
  buffers?: string[];
  buffer_paths?: (string | number)[][];
}
export interface AnywidgetSpec extends WidgetDefinition {
  /** Additional models referenced as anywidget:<id>. The root ID is root. */
  models?: Record<string, WidgetDefinition>;
}
export interface AnywidgetOutput {
  title?: string;
  spec: AnywidgetSpec;
  assets: Record<string, OutputAsset>;
}
export interface OutputOptions {
  frameUrl: string;
  hostContext: OutputHostContext;
  timeoutMs?: number;
  scheduler?: SchedulerLike;
  onState?: (state: OutputState, error?: string) => void;
}
export interface OutputHandle {
  readonly frame: HTMLIFrameElement;
  readonly state: OutputState;
  setHostContext(context: OutputHostContext): void;
  destroy(): void;
}
/** Structurally compatible with the theme/styles subset of notebook HostContext. */
export interface OutputHostContext {
  theme: "light" | "dark";
  styles?: { variables?: Readonly<Record<string, string>> };
}
export const OUTPUT_STYLE_VARIABLES: readonly string[];
export function readHostContext(element: HTMLElement, theme: "light" | "dark"): OutputHostContext;
/** Immutable mount. Bytes are copied before transfer; caller buffers remain usable. */
export function mountAnywidgetOutput(
  container: HTMLElement,
  payload: AnywidgetOutput,
  options: OutputOptions,
): OutputHandle;

/** The AFM model API, with local-only save_changes and unsupported backend send. */
export interface AnyModel<T extends Record<string, unknown> = Record<string, unknown>> {
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  on(event: `change:${string}`, callback: () => void): void;
  on(event: "msg:custom", callback: (message: unknown, buffers: DataView[]) => void): void;
  off(event?: string | null, callback?: Function | null): void;
  save_changes(): void;
  send(content: unknown, callbacks?: unknown, buffers?: ArrayBuffer[] | ArrayBufferView[]): void;
}
export interface WidgetHandle<T = unknown> {
  exports: T;
  render(options: { el: HTMLElement; signal?: AbortSignal }): Promise<void>;
}
/** AFM composition plus optional Pages theme helpers. */
export interface OutputRuntimeHost {
  getContext(): Readonly<OutputHostContext>;
  onContextChange(listener: (context: Readonly<OutputHostContext>) => void): () => void;
  getWidget<T = unknown>(ref: string): Promise<WidgetHandle<T>>;
  getModel<T extends Record<string, unknown> = Record<string, unknown>>(
    ref: string,
  ): Promise<AnyModel<T>>;
}
type Awaitable<T> = T | PromiseLike<T>;
type Cleanup = () => Awaitable<void>;
export interface Anywidget {
  initialize?(props: { model: AnyModel; signal: AbortSignal }): Awaitable<void | Cleanup | object>;
  render?(props: {
    model: AnyModel;
    el: HTMLElement;
    signal: AbortSignal;
    host: OutputRuntimeHost;
  }): Awaitable<void | Cleanup>;
}
export type AnywidgetModule = { default: Anywidget | (() => Awaitable<Anywidget>) };
