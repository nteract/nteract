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

  it("falls back to cell id and output index for legacy payloads without outputId", () => {
    expect(outputEntryIdForPayload({ cellId: "cell-a", outputIndex: 2 })).toBe("cell-a-2");
    expect(outputEntryIdForPayload({ cellId: "cell-a" }, { fallbackIndex: 3 })).toBe("cell-a-3");
  });

  it("keeps no-id single renders transient while no-id batch renders are positional", () => {
    expect(
      outputEntryIdForPayload(
        {},
        {
          transientFallback: true,
          createTransientId: () => "output-transient",
        },
      ),
    ).toBe("output-transient");
    expect(outputEntryIdForPayload({}, { fallbackIndex: 4 })).toBe("output-4");
  });
});
