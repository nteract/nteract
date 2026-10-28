/** The preload bridge, shared by the preload and the renderer. Types only. */

export type OpenedFile = { path: string; byteLength: number; revision: string };

export type ReadRangeRequest = {
  path: string;
  offset: number;
  length: number;
  expectedRevision: string;
};

export type ReadRangeResult =
  | { status: "read"; bytes: Uint8Array }
  | { status: "conflict"; diskRevision: string };

export type HarnessBridge = {
  /** A path the main process allowed, or `undefined` for the open dialog. `null` if cancelled. */
  openFile(path?: string): Promise<OpenedFile | null>;
  stat(path: string): Promise<{ byteLength: number; revision: string }>;
  readRange(request: ReadRangeRequest): Promise<ReadRangeResult>;
};

declare global {
  interface Window {
    harness: HarnessBridge;
  }
}
