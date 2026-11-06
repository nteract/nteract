import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import { PoolErrorBanner } from "../PoolErrorBanner";

describe("PoolErrorBanner", () => {
  it("renders nothing when there are no pool errors", () => {
    const { container } = render(
      <PoolErrorBanner
        uvError={null}
        condaError={null}
        pixiError={null}
        onDismissUv={() => {}}
        onDismissConda={() => {}}
        onDismissPixi={() => {}}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("routes settings through an adapter callback", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(
      <PoolErrorBanner
        uvError={{
          message: "Failed to warm uv environment",
          failed_package: "reqeusts",
          error_kind: "invalid_package",
          consecutive_failures: 3,
          retry_in_secs: 60,
          receivedAt: Date.now(),
        }}
        condaError={null}
        pixiError={null}
        onDismissUv={() => {}}
        onDismissConda={() => {}}
        onDismissPixi={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByText("Failed to warm uv environment")).toBeInTheDocument();

    await user.click(screen.getByText("Settings"));

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("omits settings action when the host does not provide one", () => {
    render(
      <PoolErrorBanner
        uvError={{
          message: "Failed to warm uv environment",
          failed_package: "reqeusts",
          error_kind: "invalid_package",
          consecutive_failures: 3,
          retry_in_secs: 60,
          receivedAt: Date.now(),
        }}
        condaError={null}
        pixiError={null}
        onDismissUv={() => {}}
        onDismissConda={() => {}}
        onDismissPixi={() => {}}
      />,
    );

    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("renders ANSI in pool error titles without literal escape bytes", () => {
    render(
      <PoolErrorBanner
        uvError={null}
        condaError={{
          message: "Environment warmup \x1b[33mtimed out\x1b[0m",
          error_kind: "timeout",
          consecutive_failures: 1,
          retry_in_secs: 60,
          receivedAt: Date.now(),
        }}
        pixiError={null}
        onDismissUv={() => {}}
        onDismissConda={() => {}}
        onDismissPixi={() => {}}
      />,
    );

    const styledTitle = screen.getByText("timed out");
    const title = styledTitle.parentElement;
    expect(title?.textContent).toBe("Environment warmup timed out");
    expect(title?.textContent).not.toContain("\x1b");
    expect(styledTitle).toHaveClass("ansi-yellow-fg");
  });

  it("provides a title when a pool error contains only ANSI controls", () => {
    render(
      <PoolErrorBanner
        uvError={{
          message: "\x1b[2K\x1b[1G",
          error_kind: "setup_failed",
          consecutive_failures: 1,
          retry_in_secs: 60,
          receivedAt: Date.now(),
        }}
        condaError={null}
        pixiError={null}
        onDismissUv={() => {}}
        onDismissConda={() => {}}
        onDismissPixi={() => {}}
      />,
    );

    expect(screen.getByText("UV environment warmup failed")).toBeInTheDocument();
  });
  it("says retries are automatic only while the pool is not parked", () => {
    const base = {
      message: "warm-env subprocess timed out",
      error_kind: "timeout",
      consecutive_failures: 2,
      retry_in_secs: 60,
      receivedAt: Date.now(),
    };
    const { rerender } = render(
      <PoolErrorBanner
        uvError={base}
        condaError={null}
        pixiError={null}
        onDismissUv={() => {}}
        onDismissConda={() => {}}
        onDismissPixi={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByText("Retrying automatically")).toBeInTheDocument();
    expect(screen.queryByText("Settings")).toBeNull();

    rerender(
      <PoolErrorBanner
        uvError={{ ...base, consecutive_failures: 5, retry_in_secs: 1800, parked: true }}
        condaError={null}
        pixiError={null}
        onDismissUv={() => {}}
        onDismissConda={() => {}}
        onDismissPixi={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.queryByText("Retrying automatically")).toBeNull();
    expect(
      screen.getByText(
        "Paused after repeated failures. Retries when you start a UV kernel, when uv settings change, or every 30 minutes",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
});
