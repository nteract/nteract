import { describe, expect, it } from "vite-plus/test";
import { selectMimeType } from "../mime-priority";

describe("selectMimeType", () => {
  it("prefers Vega-Lite over HTML fallbacks", () => {
    expect(
      selectMimeType({
        "text/html": "<div>fallback table</div>",
        "application/vnd.vegalite.v5+json": JSON.stringify({ mark: "bar" }),
        "text/plain": "fallback",
      }),
    ).toBe("application/vnd.vegalite.v5+json");
  });

  it("keeps known Vega versions in priority order", () => {
    expect(
      selectMimeType({
        "application/vnd.vegalite.v4+json": JSON.stringify({ mark: "point" }),
        "application/vnd.vegalite.v5+json": JSON.stringify({ mark: "bar" }),
      }),
    ).toBe("application/vnd.vegalite.v5+json");
  });

  it("prefers future Vega MIME variants over HTML fallbacks", () => {
    expect(
      selectMimeType({
        "text/html": "<div>fallback chart</div>",
        "application/vnd.vegalite.v7+json": JSON.stringify({ mark: "line" }),
      }),
    ).toBe("application/vnd.vegalite.v7+json");
  });
});
