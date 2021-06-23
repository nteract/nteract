import { ChildProcess } from "child_process";

import * as Immutable from "immutable";
import { Observable, Subject } from "rxjs";

import { KernelId, SessionId } from "../ids";
import { HostRef, KernelRef } from "../refs";

import { KernelInfo } from "./kernel-info";

// See #3427. This represents the kernel early in the launch process.
// With a bit more work we could probably drop this and just use either
// Local or RemoteKernelProps as our initial representation of the kernel,
// deriving local-vs-remote from known sources of truth about kernels.
export interface KernelNotStartedProps {
  kernelSpecName?: string | null;
  status?: string | null;
  // The following properties are not known immediately at the start of
  // launch; they are just included to keep Flow happy and minimize the
  // impact of this likely-to-be-deleted type.
  type: "unknown";
  cwd: ".";
  channels: Subject<any>;
  info?: KernelInfo | null;
}

export type KernelNotStartedRecord = Immutable.RecordOf<KernelNotStartedProps>;

export const makeKernelNotStartedRecord = Immutable.Record<
  KernelNotStartedProps
>({
  kernelSpecName: null,
  status: null,
  type: "unknown",
  cwd: ".",
  channels: new Subject(),
  info: null
});

export enum KernelStatus {
  /** Kernel is currently executing code. */
  Busy = "busy",
  /** Kernel is currently not executing code. */
  Idle = "idle",
  /** Kernel process is being launched. */
  Starting = "starting",
  /** Kernel is being shut down. */
  ShuttingDown = "shutting down",
  /** Kernel is restarting. */
  Restarting = "restarting",
  /** Kernel's current execution process has been interrupted. */
  Interrupted = "interrupted",
  /** Kernel is not connected to current notebook. */
  NotConnected = "not connected",
  /** 0mq-based kernel is launched. */
  Launched = "launched",
  /** 0mq-based kernel is killed. */
  Killed = "killed",
  /** Kernel is in an failed or error state. */
  Error = "error"
}

export interface LocalKernelProps {
  kernelSpecName?: string | null;
  info?: KernelInfo | null;
  hostRef?: HostRef | null;
  lastActivity?: Date | null;
  channels: Subject<any>;
  cwd: string;
  // Canonically: idle, busy, starting
  // Xref: http://jupyter-client.readthedocs.io/en/stable/messaging.html#kernel-status
  //
  // We also use this for other bits of lifecycle, including: launching,
  //   shutting down, not connected.
  status?: string | null;
  type: "zeromq";
  spawn?: ChildProcess | null;
  connectionFile?: string | null;
}

export const makeLocalKernelRecord = Immutable.Record<LocalKernelProps>({
  type: "zeromq",
  cwd: ".",
  info: null,
  kernelSpecName: null,
  hostRef: null,
  lastActivity: null,
  channels: new Subject(),
  status: null,
  spawn: null,
  connectionFile: null
});

export type LocalKernelRecord = Immutable.RecordOf<LocalKernelProps>;

export interface RemoteKernelProps {
  kernelSpecName?: string | null;
  info?: KernelInfo | null;
  hostRef?: HostRef | null;
  lastActivity?: Date | null;
  channels: Subject<any>;
  cwd: string;
  // Canonically: idle, busy, starting
  // Xref: http://jupyter-client.readthedocs.io/en/stable/messaging.html#kernel-status
  //
  // We also use this for other bits of lifecycle, including: launching,
  //   shutting down, not connected.
  status?: string | null;
  type: "websocket";
  // Xref: https://jupyter-client.readthedocs.io/en/stable/messaging.html#message-header
  // Each client has it's own unique session ID that is used to connect to the remote kernel. 
  sessionId?: SessionId | null; // unique client session ID
  remoteSessionId?: SessionId | null; // unique sessionID on the server
  id?: KernelId | null;
}

export const makeRemoteKernelRecord = Immutable.Record<RemoteKernelProps>({
  type: "websocket",
  info: null,
  cwd: ".",
  id: null,
  kernelSpecName: null,
  hostRef: null,
  lastActivity: null,
  channels: new Subject(),
  sessionId: null,
  remoteSessionId: null,
  status: null
});

export type RemoteKernelRecord = Immutable.RecordOf<RemoteKernelProps>;

export type KernelRecord =
  | KernelNotStartedRecord
  | LocalKernelRecord
  | RemoteKernelRecord;

export interface KernelsRecordProps {
  byRef: Immutable.Map<KernelRef, KernelRecord>;
}

export const makeKernelsRecord = Immutable.Record<KernelsRecordProps>({
  byRef: Immutable.Map()
});
