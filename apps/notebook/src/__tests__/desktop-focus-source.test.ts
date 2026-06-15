import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe("desktop focused cell source of truth", () => {
  it("uses the shared cell UI store instead of a useNotebook React shadow", () => {
    const hookSourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/hooks/useAutomergeNotebook.ts"),
      "utf8",
    );
    const appSourceText = readFileSync(join(process.cwd(), "apps/notebook/src/App.tsx"), "utf8");

    expect(hookSourceText).not.toMatch(/\[focusedCellId, setFocusedCellId\] = useState/);
    expect(hookSourceText).toMatch(/onFocusCell: focusCellInStore/);
    expect(appSourceText).toMatch(/const focusedCellId = useFocusedCellId\(\)/);
    expect(appSourceText).toMatch(/const focusCellInStore = useCallback/);
    expect(appSourceText).toMatch(/setFocusedCellId\(cellId\);\s*flushCellUIState\(\);/);
    expect(appSourceText).toMatch(
      /useNotebookCellUIStateBridge\(\{\s*searchQuery: globalFind\.query,\s*searchCurrentMatch: globalFind\.currentMatch,\s*\}\);/,
    );
    expect(appSourceText).toMatch(/h\.handleAddCell\(type, getFocusedCellId\(\)\)/);
    expect(appSourceText).toMatch(/onFocusCell=\{handleNotebookViewFocus\}/);
  });
});
