export type RuntimeKind = "python" | "deno" | (string & {});
export type PackageManager = "uv" | "conda" | "pixi";
export type CreateNotebookEnvironmentMode = "auto" | "project" | "notebook";

export type CommentsNotebookRef =
  | { kind: "hosted_room"; room_locator: string }
  | { kind: "local_path"; canonical_path: string }
  | { kind: "local_room"; room_id: string };

export interface CreateRelayOptions {
  runtime?: RuntimeKind;
  workingDir?: string;
  socketPath?: string;
  notebookId?: string;
  peerLabel?: string;
  description?: string;
  ephemeral?: boolean;
  dependencies?: string[];
  packageManager?: PackageManager;
  environmentMode?: CreateNotebookEnvironmentMode;
}

export interface OpenRelayOptions {
  socketPath?: string;
  peerLabel?: string;
  description?: string;
}

export interface RelayInfo {
  notebookId: string;
  cellCount?: number;
  needsTrustApproval?: boolean;
  ephemeral?: boolean;
  notebookPath?: string;
  runtime?: string;
  actorLabel?: string;
  connectionScope?: string;
  commentsDocId?: string;
  commentsNotebookRef: CommentsNotebookRef | null;
  protocol: string;
  protocolVersion?: number;
  daemonVersion?: string;
  socketPath: string;
  blobPort?: number;
  isDevMode: boolean;
}

export type RelayFrame = Buffer | Uint8Array | DataView | ArrayBuffer;

/**
 * Native, host-neutral byte pipe for one browser/WASM notebook peer.
 * Frames include the one-byte typed-frame discriminator and no length prefix.
 */
export class RelaySession {
  readonly notebookId: string;
  readonly info: RelayInfo;
  readonly closed: boolean;
  send(frame: RelayFrame): Promise<void>;
  onFrame(listener: (frame: Buffer) => void): () => void;
  onClose(listener: () => void): () => void;
  /** Terminal cancellation. Buffered frames not yet observed by a listener are discarded. */
  close(): Promise<void>;
}

export function createRelay(options?: CreateRelayOptions): Promise<RelaySession>;
export function openRelayPath(path: string, options?: OpenRelayOptions): Promise<RelaySession>;
export function connectRelay(notebookId: string, options?: OpenRelayOptions): Promise<RelaySession>;
