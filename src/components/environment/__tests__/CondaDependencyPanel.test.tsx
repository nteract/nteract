import { render, screen } from "@testing-library/react";
import type { EnvironmentYmlInfo } from "runtimed";
import { describe, expect, it, vi } from "vite-plus/test";
import { CondaDependencyPanel, type CondaDependencyPanelProps } from "../CondaDependencyPanel";

function envYmlInfo(overrides: Partial<EnvironmentYmlInfo> = {}): EnvironmentYmlInfo {
  return {
    path: "C:\\Users\\Owen\\rankings\\environment.yml",
    relative_path: "environment.yml",
    name: null,
    prefix: null,
    has_dependencies: false,
    dependency_count: 0,
    has_pip_dependencies: false,
    pip_dependency_count: 0,
    python: null,
    channels: [],
    ...overrides,
  };
}

function renderPanel(props: Partial<CondaDependencyPanelProps>) {
  return render(
    <CondaDependencyPanel
      dependencies={[]}
      channels={[]}
      python={null}
      loading={false}
      syncState={null}
      envSource="conda:env_yml"
      readOnly
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onSetChannels={vi.fn()}
      onSetPython={vi.fn()}
      onSyncNow={vi.fn()}
      {...props}
    />,
  );
}

describe("CondaDependencyPanel environment.yml banner", () => {
  it("names the existing env an environment.yml selects by name", () => {
    renderPanel({ environmentYmlInfo: envYmlInfo({ name: "rankings" }) });
    expect(screen.getByTestId("conda-env-yml-target")).toHaveTextContent("(rankings)");
  });

  it("shows an explicit prefix, including spaces, when the file has no name", () => {
    renderPanel({
      environmentYmlInfo: envYmlInfo({ prefix: "C:\\Users\\Owen\\envs\\my env" }),
    });
    expect(screen.getByTestId("conda-env-yml-target")).toHaveTextContent(
      "(C:\\Users\\Owen\\envs\\my env)",
    );
  });

  it("omits the target when the file selects neither", () => {
    renderPanel({ environmentYmlInfo: envYmlInfo() });
    expect(screen.getByText("environment.yml")).toBeInTheDocument();
    expect(screen.queryByTestId("conda-env-yml-target")).not.toBeInTheDocument();
  });
});
