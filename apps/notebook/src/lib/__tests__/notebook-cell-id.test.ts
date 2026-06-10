import { describe, expect, it } from "vite-plus/test";
import { createNotebookCellId } from "../notebook-cell-id";

describe("createNotebookCellId", () => {
  it("uses randomUUID when available", () => {
    const id = createNotebookCellId({
      randomUUID: () => "random-id",
      getRandomValues: () => {
        throw new Error("getRandomValues should not be called");
      },
    });

    expect(id).toBe("random-id");
  });

  it("falls back to random bytes without timestamp collisions", () => {
    const id = createNotebookCellId({
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab);
        return bytes;
      },
    });

    expect(id).toBe("cell-abababababababababababababababab");
  });

  it("keeps a monotonic fallback when crypto is unavailable", () => {
    const first = createNotebookCellId(null);
    const second = createNotebookCellId(null);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^cell-[a-z0-9]+-[a-z0-9]+$/);
    expect(second).toMatch(/^cell-[a-z0-9]+-[a-z0-9]+$/);
  });
});
