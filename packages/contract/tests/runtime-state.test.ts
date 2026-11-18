// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PROJECT_TRUST_STATE,
  DEFAULT_RUNTIME_STATE,
  KERNEL_ERROR_REASON,
  diffExecutions,
  type ExecutionState,
  type RuntimeState,
} from "@runtimed/contract/runtime-state";

describe("@runtimed/contract/runtime-state", () => {
  it("exports the kernel error reasons the daemon writes", () => {
    expect(KERNEL_ERROR_REASON.MISSING_IPYKERNEL).toBe("missing_ipykernel");
    expect(KERNEL_ERROR_REASON.CONDA_ENV_YML_MISSING).toBe("conda_env_yml_missing");
  });

  it("starts with a kernel that has not started and an empty queue", () => {
    const state: RuntimeState = DEFAULT_RUNTIME_STATE;
    expect(state.kernel.lifecycle).toEqual({ lifecycle: "NotStarted" });
    expect(state.queue).toEqual({ executing: null, queued: [] });
    expect(DEFAULT_PROJECT_TRUST_STATE.needs_approval).toBe(false);
  });

  it("reports a running to done transition", () => {
    const running: ExecutionState = { status: "running", execution_count: 3, success: null };
    const done: ExecutionState = { status: "done", execution_count: 3, success: true };
    expect(diffExecutions({ e1: running }, { e1: done })).toEqual([
      { execution_id: "e1", kind: "done", execution_count: 3 },
    ]);
  });
});
