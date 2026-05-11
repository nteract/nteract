import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../onboarding/App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

function chooseUvRuntime() {
  fireEvent.click(screen.getByRole("button", { name: /Python/ }));
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  fireEvent.click(screen.getByRole("button", { name: /UV/ }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
}

describe("onboarding flow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("does not allow onboarding completion while the selected pool is still warming", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "get_daemon_status") {
        return Promise.resolve({ status: "ready", endpoint: "test" });
      }
      if (command === "get_pool_status") {
        return Promise.resolve({
          uv: { available: 0, warming: 1, pool_size: 2 },
        });
      }
      return Promise.resolve();
    });

    render(<App />);
    chooseUvRuntime();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Setting up/ })).toBeDisabled();
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "complete_onboarding",
      expect.objectContaining({ defaultPythonEnv: "uv" }),
    );
  });

  it("allows onboarding completion after the selected pool has an available env", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "get_daemon_status") {
        return Promise.resolve({ status: "ready", endpoint: "test" });
      }
      if (command === "get_pool_status") {
        return Promise.resolve({
          uv: { available: 1, warming: 0, pool_size: 2 },
        });
      }
      return Promise.resolve();
    });

    render(<App />);
    chooseUvRuntime();

    const startButton = await screen.findByRole("button", { name: /Share ping and start/ });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "complete_onboarding",
        expect.objectContaining({ defaultPythonEnv: "uv" }),
      );
    });
  });
});
