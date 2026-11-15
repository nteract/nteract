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
export interface EsmOutput {
  title?: string;
  module: OutputAsset;
  inputs: Record<string, OutputAsset>;
  state?: Record<string, unknown>;
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
/** Immutable mount. Input bytes are copied before transfer; caller buffers remain usable. */
export function mountEsmOutput(
  container: HTMLElement,
  payload: EsmOutput,
  options: OutputOptions,
): OutputHandle;

/** Extensions provided to the module's render({ host }) alongside AFM composition. */
export interface OutputRuntimeHost {
  getContext(): Readonly<OutputHostContext>;
  onContextChange(listener: (context: Readonly<OutputHostContext>) => void): () => void;
  getWidget(ref: string): Promise<never>;
  getModel(ref: string): Promise<never>;
}
