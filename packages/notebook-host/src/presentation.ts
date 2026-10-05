import type { NotebookPresentationConfig } from "./types";

/** Validate the bounded presentation contract without coercing runtime values. */
export function isNotebookPresentationConfig(value: unknown): value is NotebookPresentationConfig {
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const config = value as Record<string, unknown>;
  if (Reflect.ownKeys(config).some((key) => key !== "rail")) return false;
  if (config.rail === undefined) return true;
  if (Object.prototype.toString.call(config.rail) !== "[object Object]") {
    return false;
  }
  const rail = config.rail as Record<string, unknown>;
  return (
    Reflect.ownKeys(rail).every((key) =>
      ["visible", "side", "initialCollapsed", "initialPanel"].includes(String(key)),
    ) &&
    (rail.visible === undefined || typeof rail.visible === "boolean") &&
    (rail.side === undefined || rail.side === "left" || rail.side === "right") &&
    (rail.initialCollapsed === undefined || typeof rail.initialCollapsed === "boolean") &&
    (rail.initialPanel === undefined ||
      rail.initialPanel === "outline" ||
      rail.initialPanel === "packages")
  );
}

/** Take an immutable bootstrap snapshot; omitted options retain renderer defaults. */
export function normalizeNotebookPresentationConfig(
  value: unknown,
): NotebookPresentationConfig | undefined {
  if (value === undefined) return undefined;
  if (!isNotebookPresentationConfig(value)) {
    throw new Error("Invalid notebook presentation config.");
  }
  if (value.rail === undefined) return Object.freeze({});
  const { visible, side, initialCollapsed, initialPanel } = value.rail;
  return Object.freeze({
    rail: Object.freeze({
      ...(visible !== undefined ? { visible } : {}),
      ...(side !== undefined ? { side } : {}),
      ...(initialCollapsed !== undefined ? { initialCollapsed } : {}),
      ...(initialPanel !== undefined ? { initialPanel } : {}),
    }),
  });
}
