import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookSettingsDrawer } from "../NotebookSettingsDrawer";
import type { NotebookActorIdentity } from "../capabilities";

function actor(overrides: Partial<NotebookActorIdentity> = {}): NotebookActorIdentity {
  return {
    id: "user:anaconda:leslie",
    label: "Leslie D.",
    detail: null,
    kind: "human",
    ...overrides,
  };
}

function renderDrawer(props: Partial<Parameters<typeof NotebookSettingsDrawer>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onThemeChange = vi.fn();
  const onColorThemeChange = vi.fn();
  const result = render(
    <NotebookSettingsDrawer
      open
      onOpenChange={onOpenChange}
      theme="system"
      onThemeChange={onThemeChange}
      colorTheme="classic"
      onColorThemeChange={onColorThemeChange}
      actor={actor()}
      accountDetail="leslie@anaconda.com"
      {...props}
    />,
  );
  return { ...result, onOpenChange, onThemeChange, onColorThemeChange };
}

function themeOption(value: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-theme-value="${value}"]`);
  expect(element).not.toBeNull();
  return element!;
}

function paletteOption(value: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-color-theme-value="${value}"]`);
  expect(element).not.toBeNull();
  return element!;
}

describe("NotebookSettingsDrawer", () => {
  it("renders as a right-side drawer", () => {
    renderDrawer();
    const content = document.querySelector('[data-slot="notebook-settings-drawer"]');
    expect(content).not.toBeNull();
    expect(content?.className).toContain("data-[state=open]:slide-in-from-right");
    expect(content?.className).toContain("right-0");
  });

  it("renders nothing while closed", () => {
    renderDrawer({ open: false });
    expect(document.querySelector('[data-slot="notebook-settings-drawer"]')).toBeNull();
  });

  it("marks the current theme selected without resolving system to light or dark", () => {
    renderDrawer({ theme: "system" });
    expect(themeOption("system").getAttribute("aria-checked")).toBe("true");
    expect(themeOption("light").getAttribute("aria-checked")).toBe("false");
    expect(themeOption("dark").getAttribute("aria-checked")).toBe("false");
  });

  it("reports theme choices to the host instead of storing them locally", async () => {
    const user = userEvent.setup();
    const { onThemeChange } = renderDrawer({ theme: "system" });

    await user.click(themeOption("dark"));
    expect(onThemeChange).toHaveBeenCalledWith("dark");
    expect(themeOption("system").getAttribute("aria-checked")).toBe("true");
  });

  it("marks the current palette selected independently of light/dark", () => {
    renderDrawer({ theme: "dark", colorTheme: "cream" });
    expect(paletteOption("cream").getAttribute("aria-checked")).toBe("true");
    expect(paletteOption("classic").getAttribute("aria-checked")).toBe("false");
    expect(themeOption("dark").getAttribute("aria-checked")).toBe("true");
  });

  it("reports palette choices to the host instead of storing them locally", async () => {
    const user = userEvent.setup();
    const { onColorThemeChange } = renderDrawer({ colorTheme: "classic" });

    await user.click(paletteOption("cream"));
    expect(onColorThemeChange).toHaveBeenCalledWith("cream");
    expect(paletteOption("classic").getAttribute("aria-checked")).toBe("true");
  });

  it("omits the palette row on hosts with no palette writer", () => {
    renderDrawer({ colorTheme: undefined, onColorThemeChange: undefined });
    expect(document.querySelector("[data-color-theme-value]")).toBeNull();
    expect(themeOption("system").getAttribute("aria-checked")).toBe("true");
  });

  it("scopes each palette swatch to the palette it previews", () => {
    renderDrawer({ colorTheme: "classic" });
    expect(paletteOption("cream").querySelector("[data-color-theme='cream']")).not.toBeNull();
    expect(paletteOption("classic").querySelector("[data-color-theme]")).toBeNull();
  });

  it("shows the account identity read-only with host-owned actions", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    renderDrawer({
      accountActions: (
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      ),
    });

    expect(screen.getByText("Leslie D.")).toBeTruthy();
    expect(screen.getByText("leslie@anaconda.com")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("omits the account section entirely when there is no identity", () => {
    renderDrawer({ actor: null, accountDetail: null });
    expect(screen.queryByText("Account")).toBeNull();
    expect(screen.getByText("Appearance")).toBeTruthy();
  });

  it("drops the secondary line when an identity has no email", () => {
    renderDrawer({ accountDetail: null });
    expect(screen.getByText("Account")).toBeTruthy();
    expect(screen.getByText("Leslie D.")).toBeTruthy();
    expect(screen.queryByText("leslie@anaconda.com")).toBeNull();
  });

  it("keeps focus rings on the design-law treatment", () => {
    renderDrawer();
    const option = themeOption("light");
    expect(option.className).toContain("focus-visible:ring-1");
    expect(option.className).toContain("focus-visible:ring-ring");
    expect(option.className).not.toContain("ring-offset");
  });
});
