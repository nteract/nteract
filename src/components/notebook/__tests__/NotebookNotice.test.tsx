import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlertTriangle } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  NotebookNotice,
  NotebookNoticeAction,
  NotebookNoticeDetails,
  NotebookNoticeStack,
} from "../NotebookNotice";

describe("NotebookNotice", () => {
  it("renders shared title, body, details, tone, and icon slots", () => {
    render(
      <NotebookNotice
        tone="warning"
        icon={<AlertTriangle />}
        title="Runtime unavailable"
        details={<pre>socket timed out</pre>}
      >
        Reconnect the daemon.
      </NotebookNotice>,
    );

    const notice = screen.getByText("Runtime unavailable").closest("[data-slot='notebook-notice']");
    expect(notice).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("Reconnect the daemon.")).toBeVisible();
    expect(screen.getByText("socket timed out")).toBeVisible();
  });

  it("renders action and dismiss controls", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onDismiss = vi.fn();

    render(
      <NotebookNotice
        tone="error"
        title="Live room failed"
        actions={<NotebookNoticeAction onClick={onAction}>Retry</NotebookNoticeAction>}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("renders a shared stack slot for host notices", () => {
    render(
      <NotebookNoticeStack>
        <NotebookNotice title="Runtime unavailable">Reconnect the daemon.</NotebookNotice>
        <NotebookNotice title="Auth needs attention">Sign in again.</NotebookNotice>
      </NotebookNoticeStack>,
    );

    const stack = screen
      .getByText("Runtime unavailable")
      .closest("[data-slot='notebook-notice-stack']");
    expect(stack).not.toBeNull();
    expect(stack).toContainElement(
      screen.getByText("Auth needs attention").closest("[data-slot='notebook-notice']"),
    );
  });

  it("renders ANSI details without literal escape bytes", () => {
    const { container } = render(
      <NotebookNotice
        title="Runtime unavailable"
        details={<NotebookNoticeDetails>{"stderr: \x1b[31mfailed\x1b[0m"}</NotebookNoticeDetails>}
      />,
    );

    const details = container.querySelector("pre");
    expect(details?.textContent).toBe("stderr: failed");
    expect(details?.textContent).not.toContain("\x1b");
    expect(details?.querySelector(".ansi-red-fg")).toHaveTextContent("failed");
  });
});
