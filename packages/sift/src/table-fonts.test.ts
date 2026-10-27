import { clearCache, prepare } from "@chenglou/pretext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CELL_FONT } from "./auto-width";
import { type Column, createTable, type TableData, type TableEngine } from "./table";

const columns: Column[] = [
  {
    key: "name",
    label: "Name",
    width: 150,
    sortable: true,
    numeric: false,
    columnType: "categorical",
  },
];

function makeData(count: number): TableData {
  return {
    columns,
    rowCount: count,
    getCell: (r) => `Person ${r}`,
    getCellRaw: (r) => `Person ${r}`,
    columnSummaries: [null],
  };
}

/** Real pretext throws a RangeError for a font string Canvas ignores. */
function rejectFontsOtherThanDefault() {
  vi.mocked(prepare).mockImplementation((text: string, font: string) => {
    if (font !== DEFAULT_CELL_FONT) throw new RangeError(`bad font: ${font}`);
    return { __brand: "PreparedText", text } as unknown as ReturnType<typeof prepare>;
  });
}

function fontsPreparedWith(): string[] {
  return vi.mocked(prepare).mock.calls.map(([, font]) => font);
}

describe("cell font", () => {
  let container: HTMLDivElement;
  let style: HTMLStyleElement | null = null;
  let engine: TableEngine | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(prepare).mockReset();
    vi.mocked(prepare).mockImplementation(
      (text: string) =>
        ({ __brand: "PreparedText", text }) as unknown as ReturnType<typeof prepare>,
    );
    vi.mocked(clearCache).mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    engine?.destroy();
    engine = null;
    container.remove();
    style?.remove();
    style = null;
    vi.useRealTimers();
  });

  it("measures with the default font when pretext rejects the resolved family", async () => {
    // jsdom resolves an unstyled font-family to "depends on user agent".
    rejectFontsOtherThanDefault();

    engine = createTable(container, makeData(5));
    await vi.advanceTimersByTimeAsync(20);

    const { calls, results } = vi.mocked(prepare).mock;
    const accepted = calls.filter((_, i) => results[i].type === "return").map(([, font]) => font);
    expect(accepted.length).toBeGreaterThan(0);
    expect(new Set(accepted)).toEqual(new Set([DEFAULT_CELL_FONT]));
  });

  it("measures with the family .sift-cell renders in", async () => {
    style = document.createElement("style");
    style.textContent = '.sift-root .sift-cell { font-family: "Fira Sans", Arial, sans-serif; }';
    document.head.appendChild(style);

    engine = createTable(container, makeData(5));
    await vi.advanceTimersByTimeAsync(20);

    expect(new Set(fontsPreparedWith())).toEqual(new Set(['14px "Fira Sans", Arial, sans-serif']));
  });

  it("clears pretext's cache and re-prepares prepared rows when a font loads", async () => {
    engine = createTable(container, makeData(5));
    await vi.advanceTimersByTimeAsync(20);
    vi.mocked(prepare).mockClear();

    document.fonts.dispatchEvent(new Event("loadingdone"));

    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prepare).mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(["Person 0", "Person 4"]),
    );
  });

  it("ignores loads of families the cells don't use", async () => {
    rejectFontsOtherThanDefault();
    engine = createTable(container, makeData(5));
    await vi.advanceTimersByTimeAsync(20);
    vi.mocked(prepare).mockClear();

    const event = Object.assign(new Event("loadingdone"), {
      fontfaces: [{ family: "JetBrains Mono" }],
    });
    document.fonts.dispatchEvent(event);
    expect(clearCache).not.toHaveBeenCalled();

    const inter = Object.assign(new Event("loadingdone"), {
      fontfaces: [{ family: '"Inter"' }],
    });
    document.fonts.dispatchEvent(inter);
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it("stops listening for font loads after destroy", async () => {
    engine = createTable(container, makeData(5));
    await vi.advanceTimersByTimeAsync(20);
    engine.destroy();
    engine = null;
    vi.mocked(prepare).mockClear();

    document.fonts.dispatchEvent(new Event("loadingdone"));

    expect(clearCache).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
