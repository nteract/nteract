import { describe, expect, it } from "vite-plus/test";
import { toggleMarkdownTaskMarker } from "../markdown-task-source";

describe("toggleMarkdownTaskMarker", () => {
  it("checks an unchecked task marker within the projected source span", () => {
    const source = "- [ ] ship checkboxes\n- [x] keep outputs read-only";

    expect(
      toggleMarkdownTaskMarker(source, { sourceSpanUtf16: [0, 21] }, true),
    ).toBe("- [x] ship checkboxes\n- [x] keep outputs read-only");
  });

  it("checks an unchecked task marker when the projected source span is only the task text", () => {
    const source = "- [ ] ship checkboxes\n- [x] keep outputs read-only";

    expect(
      toggleMarkdownTaskMarker(source, { sourceSpanUtf16: [6, 20] }, true),
    ).toBe("- [x] ship checkboxes\n- [x] keep outputs read-only");
  });

  it("unchecks a checked task marker without touching neighboring list items", () => {
    const source = "- [ ] first\n- [X] second\n- [x] third";

    expect(
      toggleMarkdownTaskMarker(source, { sourceSpanUtf16: [12, 24] }, false),
    ).toBe("- [ ] first\n- [ ] second\n- [x] third");
  });

  it("returns null when the source span does not include a task marker", () => {
    expect(
      toggleMarkdownTaskMarker("- regular list item", { sourceSpanUtf16: [0, 19] }, true),
    ).toBeNull();
  });
});
