import { describe, expect, it } from "vite-plus/test";
import { hostedNotebookWindowTitle } from "../hosted-notebook-url";

describe("hostedNotebookWindowTitle", () => {
  it("projects notebook id and host without an unsaved marker", () => {
    expect(hostedNotebookWindowTitle("https://app.runt.run/n/notebook-123")).toBe(
      "notebook-123 · app.runt.run",
    );
  });

  it("falls back for non-room locators", () => {
    expect(hostedNotebookWindowTitle("https://app.runt.run/dashboard")).toBe("Cloud Notebook");
  });
});
