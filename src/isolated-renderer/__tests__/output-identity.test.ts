import { describe, expect, it } from "vite-plus/test";
import { outputEntryIdForPayload } from "../output-identity";

describe("isolated renderer output identity", () => {
  it("uses outputId as the stable renderer key across display updates", () => {
    const first = outputEntryIdForPayload({
      outputId: "display-output-1",
      cellId: "cell-a",
      outputIndex: 0,
    });
    const update = outputEntryIdForPayload({
      outputId: "display-output-1",
      cellId: "cell-a",
      outputIndex: 0,
    });

    expect(update).toBe(first);
  });

  it("uses different outputIds as different renderer keys for fresh outputs", () => {
    const first = outputEntryIdForPayload({
      outputId: "execution-1-output",
      cellId: "cell-a",
      outputIndex: 0,
    });
    const fresh = outputEntryIdForPayload({
      outputId: "execution-2-output",
      cellId: "cell-a",
      outputIndex: 0,
    });

    expect(fresh).not.toBe(first);
  });

  it("rejects payloads without outputId instead of deriving fallback identity", () => {
    expect(() => outputEntryIdForPayload({} as { outputId: string })).toThrow("missing outputId");
    expect(() => outputEntryIdForPayload({ outputId: "" })).toThrow("missing outputId");
  });
});
