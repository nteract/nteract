// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { PromptCellHeader } from "../PromptCellHeader";

describe("PromptCellHeader", () => {
  it("shows the active mode and switches to full mode", () => {
    const onSetMode = vi.fn();
    render(<PromptCellHeader mode="explore" running={false} onSetMode={onSetMode} />);

    expect(screen.getByRole("button", { name: "Explore" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Full" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Full" }));

    expect(onSetMode).toHaveBeenCalledWith("full");
  });

  it("runs the prompt when idle", () => {
    const onRun = vi.fn();
    render(<PromptCellHeader mode="explore" running={false} onRun={onRun} />);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));

    expect(onRun).toHaveBeenCalledOnce();
  });

  it("offers stop instead of run while the agent is answering", () => {
    const onRun = vi.fn();
    const onCancel = vi.fn();
    render(<PromptCellHeader mode="full" running onRun={onRun} onCancel={onCancel} />);

    expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onRun).not.toHaveBeenCalled();
  });
});
