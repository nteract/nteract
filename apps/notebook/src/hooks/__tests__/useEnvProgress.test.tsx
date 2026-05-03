import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_RUNTIME_STATE, type RuntimeState } from "runtimed";
import { resetRuntimeState, setRuntimeState } from "../../lib/runtime-state";
import { useEnvProgress } from "../useEnvProgress";

function cloneRuntimeState(): RuntimeState {
  return structuredClone(DEFAULT_RUNTIME_STATE);
}

function EnvProgressProbe() {
  const envProgress = useEnvProgress();
  return (
    <div>
      <span data-testid="active">{String(envProgress.isActive)}</span>
      <span data-testid="phase">{envProgress.phase ?? ""}</span>
      <span data-testid="status">{envProgress.statusText}</span>
    </div>
  );
}

describe("useEnvProgress", () => {
  afterEach(() => {
    resetRuntimeState();
  });

  it("projects UV project preparation from runtime state", () => {
    const state = cloneRuntimeState();
    state.env.progress = {
      env_type: "uv",
      phase: "project_preparing",
      source: "uv:pyproject",
      project_path: "/tmp/project/pyproject.toml",
    };
    setRuntimeState(state);

    render(<EnvProgressProbe />);

    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("phase")).toHaveTextContent("project_preparing");
    expect(screen.getByTestId("status")).toHaveTextContent("Preparing UV project environment...");
  });
});
