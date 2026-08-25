import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe("command-mode editor focus", () => {
  it.each(["CodeCell.tsx", "RawCell.tsx"])(
    "%s ties editor autofocus to the explicit editor interaction target",
    (fileName) => {
      const source = readFileSync(
        join(process.cwd(), "apps/notebook/src/components", fileName),
        "utf8",
      );

      expect(source).toContain("useIsCellEditorTarget(cell.id)");
      expect(source).toContain("autoFocus={isEditorTarget}");
      expect(source).not.toContain("autoFocus={isFocused}");
    },
  );

  it("does not imperatively focus a raw-cell editor for cell-only selection", () => {
    const source = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/RawCell.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*if \(isEditorTarget\)[\s\S]*?editorRef\.current\?\.focus\(\);[\s\S]*?\}, \[isEditorTarget\]\);/,
    );
  });
});
