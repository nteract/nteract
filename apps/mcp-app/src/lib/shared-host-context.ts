import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type {
  NteractEmbedDisplayMode,
  NteractEmbedHostContextPatch,
  NteractEmbedPlatform,
} from "@/components/isolated/host-context";
import { daemonRendererAssetsBaseUrl } from "./shared-renderer-plugin-loader";

const DISPLAY_MODES = new Set<NteractEmbedDisplayMode>(["inline", "fullscreen", "pip"]);
const PLATFORMS = new Set<NteractEmbedPlatform>(["web", "desktop", "mobile"]);

function stringVariables(
  variables: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!variables) return undefined;
  const entries = Object.entries(variables).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function displayMode(value: string | undefined): NteractEmbedDisplayMode | undefined {
  return DISPLAY_MODES.has(value as NteractEmbedDisplayMode)
    ? (value as NteractEmbedDisplayMode)
    : undefined;
}

function platform(value: string | undefined): NteractEmbedPlatform | undefined {
  return PLATFORMS.has(value as NteractEmbedPlatform)
    ? (value as NteractEmbedPlatform)
    : undefined;
}

export function mcpHostContextToNteractEmbedPatch(
  hostContext: McpUiHostContext | null | undefined,
  blobBaseUrl: string | undefined,
): NteractEmbedHostContextPatch {
  const variables = stringVariables(hostContext?.styles?.variables);
  const fonts = hostContext?.styles?.css?.fonts;
  const modes = hostContext?.availableDisplayModes
    ?.map(displayMode)
    .filter((mode): mode is NteractEmbedDisplayMode => mode !== undefined);
  const rendererAssetsBaseUrl = daemonRendererAssetsBaseUrl(blobBaseUrl);

  // Upstream containerDimensions describe the outer MCP App iframe. The nested
  // shared output renderer computes its own dimensions from its actual iframe.
  return {
    theme: hostContext?.theme,
    styles:
      variables || fonts
        ? {
            variables,
            css: fonts ? { fonts } : undefined,
          }
        : undefined,
    displayMode: displayMode(hostContext?.displayMode),
    availableDisplayModes: modes && modes.length > 0 ? modes : undefined,
    locale: hostContext?.locale,
    timeZone: hostContext?.timeZone,
    userAgent: hostContext?.userAgent,
    platform: platform(hostContext?.platform),
    deviceCapabilities: hostContext?.deviceCapabilities,
    safeAreaInsets: hostContext?.safeAreaInsets,
    nteract: rendererAssetsBaseUrl ? { rendererAssetsBaseUrl } : undefined,
  };
}
