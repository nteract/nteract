import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { FontFamilyPicker, fontFamilyNameToCssValue } from "../../settings/App";

const fontFamilies = ["Fraunces", "Georgia", "SF Mono", "Times New Roman"];

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
});

function renderPicker(value = "", onChange = vi.fn()) {
  render(
    <FontFamilyPicker
      label="Markdown font"
      value={value}
      onChange={onChange}
      placeholder="system-ui, sans-serif"
      description="Rendered Markdown and Markdown input"
      fontFamilies={fontFamilies}
    />,
  );
  return { onChange };
}

describe("FontFamilyPicker", () => {
  it("filters font families and commits the selected font", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Markdown font" }));
    await user.type(screen.getByPlaceholderText("Search fonts or enter a CSS stack"), "frau");
    await user.click(screen.getByText("Fraunces"));

    expect(onChange).toHaveBeenCalledWith("Fraunces");
  });

  it("quotes multi-word font names when selecting from the list", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Markdown font" }));
    await user.type(screen.getByPlaceholderText("Search fonts or enter a CSS stack"), "sf mono");
    await user.click(screen.getByText("SF Mono"));

    expect(onChange).toHaveBeenCalledWith('"SF Mono"');
  });

  it("allows a custom CSS font stack", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Markdown font" }));
    await user.type(
      screen.getByPlaceholderText("Search fonts or enter a CSS stack"),
      "Fraunces, Georgia, serif",
    );
    const option = screen.getByText("Use custom value").closest("[cmdk-item]");
    expect(option).not.toBeNull();
    await user.click(within(option as HTMLElement).getByText("Use custom value"));

    expect(onChange).toHaveBeenCalledWith("Fraunces, Georgia, serif");
  });

  it("clears back to the theme default", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker("Fraunces");

    await user.click(screen.getByRole("button", { name: "Clear markdown font" }));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("formats CSS family values for installed font names", () => {
    expect(fontFamilyNameToCssValue("Fraunces")).toBe("Fraunces");
    expect(fontFamilyNameToCssValue("SF Mono")).toBe('"SF Mono"');
    expect(fontFamilyNameToCssValue("serif")).toBe("serif");
  });
});
