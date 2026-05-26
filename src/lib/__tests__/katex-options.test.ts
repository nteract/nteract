import katex from "katex";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { katexStrict } from "../katex-options";

describe("katexStrict", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suppresses only display newline strict warnings", () => {
    expect(katexStrict("newLineInDisplayMode", "", {} as never)).toBe("ignore");
    expect(katexStrict("htmlExtension", "", {} as never)).toBe("warn");
  });

  it("prevents KaTeX from logging display newline warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const element = document.createElement("div");

    katex.render(String.raw`a \\ b`, element, {
      displayMode: true,
      throwOnError: false,
    });
    expect(
      warn.mock.calls.some(([message]) => String(message).includes("newLineInDisplayMode")),
    ).toBe(true);

    warn.mockClear();
    katex.render(String.raw`a \\ b`, element, {
      displayMode: true,
      strict: katexStrict,
      throwOnError: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
