import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fontFamilyNameToCssValue, uniqueSortedFontFamilies } from "@nteract/notebook-host";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { FontFamilyPicker } from "../../settings/App";

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
  function Harness() {
    const [currentValue, setCurrentValue] = useState(value);
    return (
      <FontFamilyPicker
        label="Markdown font"
        value={currentValue}
        onChange={(next) => {
          onChange(next);
          setCurrentValue(next);
        }}
        placeholder="system-ui, sans-serif"
        description="Rendered Markdown and Markdown input"
        fontFamilies={fontFamilies}
      />
    );
  }
  render(<Harness />);
  return { onChange };
}

describe("FontFamilyPicker", () => {
  it("filters font families and commits the selected font", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Markdown font" }));
    await user.type(screen.getByPlaceholderText("Search fonts"), "frau");
    await user.click(screen.getByText("Fraunces"));

    expect(onChange).toHaveBeenCalledWith("Fraunces");
  });

  it("quotes multi-word font names when selecting from the list", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Markdown font" }));
    await user.type(screen.getByPlaceholderText("Search fonts"), "sf mono");
    await user.click(screen.getByText("SF Mono"));

    expect(onChange).toHaveBeenCalledWith('"SF Mono"');
  });

  it("allows a custom CSS font stack via Custom mode", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Markdown font" }));
    await user.type(screen.getByPlaceholderText("Search fonts"), "Fraunces, Georgia, serif");
    expect(screen.queryByText("Use custom value")).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Search fonts"));
    await user.click(screen.getByText("Custom"));
    await user.type(
      screen.getByPlaceholderText("e.g. Helvetica, Arial, sans-serif"),
      "Fraunces, Georgia, serif",
    );

    expect(onChange).toHaveBeenCalledWith("Fraunces, Georgia, serif");
  });

  it("displays selected multi-word font names without CSS quotes", () => {
    renderPicker('"SF Mono"');

    const combobox = screen.getByRole("combobox", { name: "Markdown font" });
    expect(combobox.textContent).toContain("SF Mono");
    expect(combobox.textContent).not.toContain('"SF Mono"');
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

  it("deduplicates unicode font names case-insensitively", () => {
    expect(uniqueSortedFontFamilies(["  Ümlaut  ", "ümlaut", "Naïve", "naïve"])).toEqual([
      "Naïve",
      "Ümlaut",
    ]);
  });
});
