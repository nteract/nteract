export interface PythonExecution {
  execution_id: string;
  source: string;
}
export interface PythonExecutionResult {
  execution_count: number;
  success: boolean;
  outputs: Record<string, unknown>[];
}
export class PythonRuntimePeer {
  constructor(options: {
    peer: {
      get_runtime_state(): unknown;
      set_execution_running(id: string): void;
      set_execution_count(id: string, count: number): void;
      set_execution_done(id: string, success: boolean): void;
      set_execution_cancelled(id: string): void;
      set_kernel_error(details: string): void;
      append_output_json(id: string, manifest: string): unknown;
    };
    pool: {
      execute(key: string, execution: PythonExecution): Promise<PythonExecutionResult>;
      release(key: string): Promise<void>;
    };
    sessionKey: string;
    isCurrent(state: unknown): boolean;
    publish(): Promise<void>;
    prepareOutputs(outputs: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
  });
  drain(): Promise<void>;
  close(): Promise<void>;
}
