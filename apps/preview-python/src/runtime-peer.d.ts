export interface PythonExecution {
  execution_id: string;
  cell_id: string;
  source: string;
}
export interface PythonExecutionResult {
  execution_count: number;
  success: boolean;
  outputs: Record<string, unknown>[];
}
export type PythonLiveEvent =
  | { type: "stream"; name: "stdout" | "stderr"; text: string }
  | { type: "clear"; wait: boolean }
  | { type: "boundary" }
  | { type: "live_stopped" };
export class PythonRuntimePeer {
  constructor(options: {
    peer: {
      get_runtime_state(): unknown;
      set_execution_running(id: string): void;
      set_execution_count(id: string, count: number): void;
      set_execution_done(id: string, success: boolean): void;
      set_execution_cancelled(id: string): void;
      refresh_execution_queue(): void;
      set_kernel_error(details: string): void;
      clear_execution_outputs(id: string): boolean;
      update_display_data_json(displayId: string, data: string, metadata: string): number;
      append_output_json(id: string, manifest: string): unknown;
      replace_output_json(id: string, outputId: string, manifest: string): boolean;
    };
    pool: {
      execute(
        key: string,
        execution: PythonExecution,
        options?: { onLive?(event: PythonLiveEvent): void },
      ): Promise<PythonExecutionResult>;
      release(key: string): Promise<void>;
    };
    sessionKey: string;
    isCurrent(state: unknown): boolean;
    publish(): Promise<void>;
    /** Sync live output to peers without a storage checkpoint; enables live output. */
    publishLive?(): Promise<void>;
    prepareOutputs(outputs: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
  });
  drain(): Promise<void>;
  /** Cancel queued intent; the provider interrupts the running cell. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
