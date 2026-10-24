import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_PROJECT_TRUST_STATE, type ProjectTrustState } from "runtimed";
import { describe, expect, it, vi } from "vite-plus/test";
import { PROJECT_TRUST_DEPENDENCY_LIMIT, ProjectTrustDialog } from "../ProjectTrustDialog";

function projectTrust(overrides: Partial<ProjectTrustState> = {}): ProjectTrustState {
  return {
    ...DEFAULT_PROJECT_TRUST_STATE,
    status: "untrusted",
    needs_approval: true,
    manifest_path: "/work/repo/proj/pyproject.toml",
    kind: "pyproject_toml",
    project_dir: "/work/repo/proj",
    ...overrides,
    summary: {
      ...DEFAULT_PROJECT_TRUST_STATE.summary,
      dependencies: ["pandas>=2", "numpy"],
      ...overrides.summary,
    },
  };
}

function renderDialog(state: ProjectTrustState, props: { busy?: boolean; error?: string } = {}) {
  const onTrust = vi.fn();
  const onUseNotebookEnv = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ProjectTrustDialog
      open
      onOpenChange={onOpenChange}
      projectTrust={state}
      onTrust={onTrust}
      onUseNotebookEnv={onUseNotebookEnv}
      {...props}
    />,
  );
  return { onTrust, onUseNotebookEnv, onOpenChange };
}

describe("ProjectTrustDialog", () => {
  it("shows the manifest, the folder, and dependencies", () => {
    renderDialog(projectTrust());

    expect(screen.getByTestId("project-trust-dialog")).toBeInTheDocument();
    expect(screen.getByText("Trust this project folder?")).toBeInTheDocument();
    expect(screen.getByText(/lets uv use the files in it/)).toBeInTheDocument();
    expect(screen.getByTestId("project-trust-manifest-path")).toHaveTextContent(
      "/work/repo/proj/pyproject.toml",
    );
    expect(screen.getByTestId("project-trust-folder")).toHaveTextContent("/work/repo/proj");
    const deps = screen.getByTestId("project-trust-dependencies");
    expect(within(deps).getByText("pandas>=2")).toBeInTheDocument();
    expect(within(deps).getByText("numpy")).toBeInTheDocument();
    expect(screen.queryByTestId("project-trust-scope-repo")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-trust-environment-to-build")).not.toBeInTheDocument();
  });

  it("renders only the red flags the summary carries", () => {
    renderDialog(
      projectTrust({
        summary: {
          ...DEFAULT_PROJECT_TRUST_STATE.summary,
          build_backend: "hatchling.build",
          non_registry_sources: ["mylib @ git+https://example.com/mylib"],
          indexes_and_channels: ["https://pypi.internal/simple"],
          activation_scripts: [],
          outside_directory: ["../shared"],
        },
      }),
    );

    expect(screen.getByTestId("project-trust-flag-outside-directory")).toHaveTextContent(
      "../shared",
    );
    expect(screen.getByTestId("project-trust-flag-build-backend")).toHaveTextContent(
      "hatchling.build",
    );
    expect(screen.getByTestId("project-trust-flag-non-registry-sources")).toHaveTextContent(
      "mylib @ git+https://example.com/mylib",
    );
    expect(screen.getByTestId("project-trust-flag-indexes-and-channels")).toHaveTextContent(
      "https://pypi.internal/simple",
    );
    expect(screen.queryByTestId("project-trust-flag-activation-scripts")).not.toBeInTheDocument();
  });

  it("collapses long dependency lists", () => {
    const dependencies = Array.from(
      { length: PROJECT_TRUST_DEPENDENCY_LIMIT + 3 },
      (_, i) => `pkg-${i}`,
    );
    renderDialog(
      projectTrust({ summary: { ...DEFAULT_PROJECT_TRUST_STATE.summary, dependencies } }),
    );

    expect(screen.getByText("+3 more")).toBeInTheDocument();
    expect(screen.queryByText(`pkg-${PROJECT_TRUST_DEPENDENCY_LIMIT}`)).not.toBeInTheDocument();
  });

  it("trusts the project folder by default", async () => {
    const user = userEvent.setup();
    const { onTrust } = renderDialog(projectTrust({ repo_root: "/work/repo" }));

    await user.click(screen.getByTestId("project-trust-trust-button"));
    expect(onTrust).toHaveBeenCalledWith("/work/repo/proj");
  });

  it("passes the repository root when the user picks it", async () => {
    const user = userEvent.setup();
    const { onTrust, onUseNotebookEnv } = renderDialog(projectTrust({ repo_root: "/work/repo" }));

    await user.click(screen.getByTestId("project-trust-scope-repo"));
    await user.click(screen.getByTestId("project-trust-trust-button"));
    expect(onTrust).toHaveBeenCalledWith("/work/repo");

    await user.click(screen.getByTestId("project-trust-notebook-env-button"));
    expect(onUseNotebookEnv).toHaveBeenCalledWith("/work/repo", false);
  });

  it("passes the remember choice with the notebook environment", async () => {
    const user = userEvent.setup();
    const { onUseNotebookEnv, onTrust } = renderDialog(projectTrust());

    await user.click(screen.getByTestId("project-trust-notebook-env-button"));
    expect(onUseNotebookEnv).toHaveBeenLastCalledWith("/work/repo/proj", false);

    await user.click(screen.getByTestId("project-trust-remember-checkbox"));
    await user.click(screen.getByTestId("project-trust-notebook-env-button"));
    expect(onUseNotebookEnv).toHaveBeenLastCalledWith("/work/repo/proj", true);
    expect(onTrust).not.toHaveBeenCalled();
  });

  it("shows the environment that trusting will build", () => {
    const command = "conda env create -p /cache/envs/abc -f /work/repo/proj/environment.yml";
    renderDialog(
      projectTrust({
        kind: "environment_yml",
        manifest_path: "/work/repo/proj/environment.yml",
        summary: { ...DEFAULT_PROJECT_TRUST_STATE.summary, environment_to_build: command },
      }),
    );

    const block = screen.getByTestId("project-trust-environment-to-build");
    expect(block).toHaveTextContent("Trusting will build this environment:");
    expect(block).toHaveTextContent(command);
    expect(screen.getByText(/lets conda use the files in it/)).toBeInTheDocument();
  });

  it("shows errors and disables actions while busy", () => {
    const { onOpenChange } = renderDialog(projectTrust(), {
      busy: true,
      error: "directory does not exist",
    });

    expect(screen.getByTestId("project-trust-error")).toHaveTextContent("directory does not exist");
    expect(screen.getByTestId("project-trust-trust-button")).toBeDisabled();
    expect(screen.getByTestId("project-trust-notebook-env-button")).toBeDisabled();
    expect(screen.getByTestId("project-trust-cancel-button")).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes on cancel", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(projectTrust());

    await user.click(screen.getByTestId("project-trust-cancel-button"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
