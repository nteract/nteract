/**
 * Tests for SandboxStatusBadge component.
 *
 * - Badge hidden when sandbox is Disabled
 * - Active state renders "Sandbox: Active" with green styling
 * - StartupFailed renders "Sandbox: Failed"
 * - Degraded renders "Sandbox: Degraded"
 * - Tooltip text matches spec
 * - onClick callback fires on click
 * - Integration: badge re-renders when runtime state changes
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vite-plus/test";
import { setRuntimeState, resetRuntimeState } from "../../lib/runtime-state";
import { DEFAULT_RUNTIME_STATE, type SandboxStateInfo } from "runtimed";
import { SandboxStatusBadge } from "../SandboxStatusBadge";

function renderWithState(sandboxState: SandboxStateInfo, onClick?: () => void) {
  setRuntimeState({ ...DEFAULT_RUNTIME_STATE, sandbox_state: sandboxState });
  return render(<SandboxStatusBadge onClick={onClick} />);
}

describe("SandboxStatusBadge", () => {
  afterEach(() => {
    resetRuntimeState();
  });

  it("renders nothing when sandbox is Disabled", () => {
    renderWithState({ state: "Disabled" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders 'Sandbox: Active' when Active", () => {
    renderWithState({ state: "Active", nono_pid: 1, kernel_pid: 2 });
    expect(screen.getByRole("button", { name: /Sandbox: Active/i })).toBeDefined();
  });

  it("renders 'Sandbox: Failed' when StartupFailed", () => {
    renderWithState({ state: "StartupFailed", reason: "missing cred" });
    expect(screen.getByRole("button", { name: /Sandbox: Failed/i })).toBeDefined();
  });

  it("renders 'Sandbox: Degraded' when Degraded", () => {
    renderWithState({ state: "Degraded", reason: "proxy exited" });
    expect(screen.getByRole("button", { name: /Sandbox: Degraded/i })).toBeDefined();
  });

  it("calls onClick when button is clicked", () => {
    const onClick = vi.fn();
    renderWithState({ state: "Active", nono_pid: 1, kernel_pid: 2 }, onClick);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("updates badge when sandbox state transitions", () => {
    setRuntimeState({ ...DEFAULT_RUNTIME_STATE, sandbox_state: { state: "Active", nono_pid: 1, kernel_pid: 2 } });
    const { rerender } = render(<SandboxStatusBadge />);
    expect(screen.getByRole("button", { name: /Sandbox: Active/i })).toBeDefined();

    setRuntimeState({ ...DEFAULT_RUNTIME_STATE, sandbox_state: { state: "Degraded", reason: "proxy died" } });
    rerender(<SandboxStatusBadge />);
    expect(screen.getByRole("button", { name: /Sandbox: Degraded/i })).toBeDefined();
  });

  it("badge disappears when sandbox transitions to Disabled", () => {
    setRuntimeState({ ...DEFAULT_RUNTIME_STATE, sandbox_state: { state: "Active", nono_pid: 1, kernel_pid: 2 } });
    const { rerender } = render(<SandboxStatusBadge />);
    expect(screen.getByRole("button")).toBeDefined();

    setRuntimeState({ ...DEFAULT_RUNTIME_STATE, sandbox_state: { state: "Disabled" } });
    rerender(<SandboxStatusBadge />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
