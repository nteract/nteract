import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

type ContainerDimensions = NonNullable<McpUiHostContext["containerDimensions"]>;

function finiteDimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function dimensionValue(
  dimensions: ContainerDimensions | undefined,
  key: string,
): number | undefined {
  if (!dimensions || typeof dimensions !== "object") return undefined;
  return finiteDimension((dimensions as Record<string, unknown>)[key]);
}

export function applyMcpAppContainerDimensions(
  dimensions: ContainerDimensions | undefined,
  root: HTMLElement = document.documentElement,
) {
  const height = dimensionValue(dimensions, "height");
  const maxHeight = dimensionValue(dimensions, "maxHeight");
  const width = dimensionValue(dimensions, "width");
  const maxWidth = dimensionValue(dimensions, "maxWidth");

  if (height !== undefined) {
    root.style.height = "100vh";
    root.style.removeProperty("max-height");
  } else if (maxHeight !== undefined) {
    root.style.maxHeight = `${maxHeight}px`;
    root.style.removeProperty("height");
  } else {
    root.style.removeProperty("height");
    root.style.removeProperty("max-height");
  }

  if (width !== undefined) {
    root.style.width = "100vw";
    root.style.removeProperty("max-width");
  } else if (maxWidth !== undefined) {
    root.style.maxWidth = `${maxWidth}px`;
    root.style.removeProperty("width");
  } else {
    root.style.removeProperty("width");
    root.style.removeProperty("max-width");
  }
}

export function applyMcpAppHostDocumentContext(
  hostContext: McpUiHostContext | null | undefined,
  root: HTMLElement = document.documentElement,
) {
  if (!hostContext) return;

  if (hostContext.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext.styles?.variables) applyHostStyleVariables(hostContext.styles.variables, root);
  if (hostContext.styles?.css?.fonts) applyHostFonts(hostContext.styles.css.fonts);
  applyMcpAppContainerDimensions(hostContext.containerDimensions, root);
}
