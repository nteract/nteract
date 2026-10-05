import { describe, expect, it } from "vite-plus/test";
import {
  isNotebookPresentationConfig,
  normalizeNotebookPresentationConfig,
  type NotebookPresentationConfig,
} from "../src";

describe("embedded notebook presentation", () => {
  it("retains renderer defaults when config or fields are absent", () => {
    expect(normalizeNotebookPresentationConfig(undefined)).toBeUndefined();
    expect(normalizeNotebookPresentationConfig({})).toEqual({});
    expect(normalizeNotebookPresentationConfig({ rail: {} })).toEqual({ rail: {} });
    expect(normalizeNotebookPresentationConfig({ rail: { side: "right" } })).toEqual({
      rail: { side: "right" },
    });
    expect(normalizeNotebookPresentationConfig({ rail: { visible: undefined } })).toEqual({
      rail: {},
    });
    expect(
      normalizeNotebookPresentationConfig({
        rail: {
          visible: true,
          side: "left",
          initialCollapsed: true,
          initialPanel: "outline",
        },
      }),
    ).toEqual({
      rail: {
        visible: true,
        side: "left",
        initialCollapsed: true,
        initialPanel: "outline",
      },
    });
  });

  it.each(["outline", "packages"] as const)("snapshots the %s panel config", (initialPanel) => {
    const supplied = {
      rail: { visible: false, side: "right" as const, initialCollapsed: false, initialPanel },
    } satisfies NotebookPresentationConfig;
    expect(isNotebookPresentationConfig(supplied)).toBe(true);
    const config = normalizeNotebookPresentationConfig(supplied);
    expect(config).toEqual(supplied);
    expect(config).not.toBe(supplied);
    expect(config?.rail).not.toBe(supplied.rail);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config?.rail)).toBe(true);
    supplied.rail.visible = true;
    expect(config?.rail?.visible).toBe(false);
  });

  it.each([
    null,
    false,
    "right",
    [],
    new Date(),
    { unknown: true },
    { rail: null },
    { rail: [] },
    { rail: new Map() },
    { rail: { visible: "false" } },
    { rail: { visible: null } },
    { rail: { side: "bottom" } },
    { rail: { initialCollapsed: 1 } },
    { rail: { initialPanel: "comments" } },
    { rail: { width: 320 } },
  ])("rejects malformed runtime config %j", (value) => {
    expect(isNotebookPresentationConfig(value)).toBe(false);
    expect(() => normalizeNotebookPresentationConfig(value)).toThrow(
      "Invalid notebook presentation",
    );
  });
});
