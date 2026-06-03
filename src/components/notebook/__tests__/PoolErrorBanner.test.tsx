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
});
