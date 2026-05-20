export type NteractEmbedTheme = "light" | "dark";
export type NteractEmbedDisplayMode = "inline" | "fullscreen" | "pip";
export type NteractEmbedPlatform = "web" | "desktop" | "mobile";

export interface NteractEmbedContainerDimensions {
  width?: number;
  maxWidth?: number;
  height?: number;
  maxHeight?: number;
}

export interface NteractEmbedDeviceCapabilities {
  touch?: boolean;
  hover?: boolean;
}

export interface NteractEmbedSafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface NteractEmbedHostContext {
  theme?: NteractEmbedTheme;
  styles?: {
    variables?: Record<string, string>;
    css?: {
      fonts?: string;
    };
  };
  displayMode?: NteractEmbedDisplayMode;
  availableDisplayModes?: NteractEmbedDisplayMode[];
  containerDimensions?: NteractEmbedContainerDimensions;
  locale?: string;
  timeZone?: string;
  userAgent?: string;
  platform?: NteractEmbedPlatform;
  deviceCapabilities?: NteractEmbedDeviceCapabilities;
  safeAreaInsets?: NteractEmbedSafeAreaInsets;
  nteract?: {
    colorTheme?: string | null;
  };
}

export type NteractEmbedHostContextPatch = Omit<
  Partial<NteractEmbedHostContext>,
  "safeAreaInsets"
> & {
  safeAreaInsets?: Partial<NteractEmbedSafeAreaInsets>;
};

export interface CreateNteractEmbedHostContextOptions {
  isDark: boolean;
  colorTheme?: string | null;
  containerDimensions?: NteractEmbedContainerDimensions;
  locale?: string;
  timeZone?: string;
  userAgent?: string;
  platform?: NteractEmbedPlatform;
  deviceCapabilities?: NteractEmbedDeviceCapabilities;
  safeAreaInsets?: Partial<NteractEmbedSafeAreaInsets>;
}

interface ThemePalette {
  backgroundPrimary: string;
  backgroundSecondary: string;
  textPrimary: string;
  textSecondary: string;
  borderPrimary: string;
  accent: string;
  danger: string;
  success: string;
  siftBackground: string;
  foreground: string;
  documentFont: string;
}

const OUTPUT_UI_FONT =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const OUTPUT_MONO_FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const OUTPUT_DOCUMENT_FONT = "var(--output-ui-font)";
const CREAM_DOCUMENT_FONT = 'KaTeX_Main, Georgia, "Times New Roman", serif';
const DEFAULT_SAFE_AREA_INSETS: NteractEmbedSafeAreaInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

function themePalette(isDark: boolean, colorTheme?: string | null): ThemePalette {
  const isCream = colorTheme === "cream";
  if (isCream) {
    return {
      backgroundPrimary: "transparent",
      backgroundSecondary: isDark ? "#242120" : "#f0ede7",
      textPrimary: isDark ? "#e8e2dc" : "#1e1a18",
      textSecondary: isDark ? "#9a918a" : "#6e655f",
      borderPrimary: isDark ? "#3a3533" : "#d8cec3",
      accent: isDark ? "#d4896a" : "#955f3b",
      danger: isDark ? "#e07a64" : "#c4513a",
      success: isDark ? "#5ec98a" : "#3a8a5c",
      siftBackground: isDark ? "#1a1816" : "#f5f2ec",
      foreground: isDark ? "#e8e2dc" : "#1e1a18",
      documentFont: CREAM_DOCUMENT_FONT,
    };
  }

  if (isDark) {
    return {
      backgroundPrimary: "transparent",
      backgroundSecondary: "#1a1a1a",
      textPrimary: "#e0e0e0",
      textSecondary: "#a0a0a0",
      borderPrimary: "#333333",
      accent: "#60a5fa",
      danger: "#ef4444",
      success: "#22c55e",
      siftBackground: "#0d1117",
      foreground: "#e0e0e0",
      documentFont: OUTPUT_DOCUMENT_FONT,
    };
  }

  return {
    backgroundPrimary: "transparent",
    backgroundSecondary: "#f5f5f5",
    textPrimary: "#1a1a1a",
    textSecondary: "#666666",
    borderPrimary: "#e0e0e0",
    accent: "#3b82f6",
    danger: "#ef4444",
    success: "#22c55e",
    siftBackground: "#ffffff",
    foreground: "#1a1a1a",
    documentFont: OUTPUT_DOCUMENT_FONT,
  };
}

function hostLocale(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.language || navigator.languages?.[0];
}

function hostTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function hostUserAgent(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.userAgent;
}

function hostPlatform(): NteractEmbedPlatform {
  if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) {
    return "mobile";
  }
  return "desktop";
}

function hostDeviceCapabilities(): NteractEmbedDeviceCapabilities {
  if (typeof window === "undefined") return {};
  return {
    touch: typeof navigator !== "undefined" ? navigator.maxTouchPoints > 0 : undefined,
    hover: window.matchMedia?.("(hover: hover)").matches,
  };
}

function mergeSafeAreaInsets(
  previous: NteractEmbedSafeAreaInsets | undefined,
  next: Partial<NteractEmbedSafeAreaInsets> | undefined,
): NteractEmbedSafeAreaInsets {
  return {
    top: next?.top ?? previous?.top ?? DEFAULT_SAFE_AREA_INSETS.top,
    right: next?.right ?? previous?.right ?? DEFAULT_SAFE_AREA_INSETS.right,
    bottom: next?.bottom ?? previous?.bottom ?? DEFAULT_SAFE_AREA_INSETS.bottom,
    left: next?.left ?? previous?.left ?? DEFAULT_SAFE_AREA_INSETS.left,
  };
}

export function createNteractThemeVariables(
  isDark: boolean,
  colorTheme?: string | null,
): Record<string, string> {
  const palette = themePalette(isDark, colorTheme);

  return {
    "--color-background-primary": palette.backgroundPrimary,
    "--color-background-secondary": palette.backgroundSecondary,
    "--color-text-primary": palette.textPrimary,
    "--color-text-secondary": palette.textSecondary,
    "--color-border-primary": palette.borderPrimary,
    "--color-ring-primary": palette.accent,
    "--color-text-danger": palette.danger,
    "--color-text-success": palette.success,
    "--font-sans": OUTPUT_UI_FONT,
    "--font-mono": OUTPUT_MONO_FONT,
    "--font-text-md-size": "1rem",
    "--font-text-md-line-height": "1.5",
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-weight-semibold": "600",
    "--font-weight-bold": "700",
    "--border-radius-sm": "4px",
    "--border-radius-md": "6px",
    "--border-radius-lg": "8px",
    "--border-width-regular": "1px",

    "--bg-primary": palette.backgroundPrimary,
    "--bg-secondary": palette.backgroundSecondary,
    "--text-primary": palette.textPrimary,
    "--text-secondary": palette.textSecondary,
    "--foreground": palette.foreground,
    "--border-color": palette.borderPrimary,
    "--accent-color": palette.accent,
    "--error-color": palette.danger,
    "--success-color": palette.success,
    "--sift-bg": palette.siftBackground,
    "--output-ui-font": OUTPUT_UI_FONT,
    "--output-mono-font": OUTPUT_MONO_FONT,
    "--output-document-font": palette.documentFont,
  };
}

export function createNteractEmbedHostContext({
  isDark,
  colorTheme,
  containerDimensions,
  locale,
  timeZone,
  userAgent,
  platform,
  deviceCapabilities,
  safeAreaInsets,
}: CreateNteractEmbedHostContextOptions): NteractEmbedHostContext {
  return {
    theme: isDark ? "dark" : "light",
    styles: {
      variables: createNteractThemeVariables(isDark, colorTheme),
    },
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions,
    locale: locale ?? hostLocale(),
    timeZone: timeZone ?? hostTimeZone(),
    userAgent: userAgent ?? hostUserAgent(),
    platform: platform ?? hostPlatform(),
    deviceCapabilities: deviceCapabilities ?? hostDeviceCapabilities(),
    safeAreaInsets: mergeSafeAreaInsets(undefined, safeAreaInsets),
    nteract: {
      colorTheme: colorTheme ?? null,
    },
  };
}

export function mergeNteractEmbedHostContext(
  ...contexts: Array<NteractEmbedHostContextPatch | null | undefined>
): NteractEmbedHostContext {
  const merged: NteractEmbedHostContext = {};

  for (const context of contexts) {
    if (!context) continue;
    const previousStyles = merged.styles;
    const previousDeviceCapabilities = merged.deviceCapabilities;
    const previousSafeAreaInsets = merged.safeAreaInsets;
    const previousNteract = merged.nteract;
    Object.assign(merged, context);

    if (context.styles) {
      merged.styles = {
        ...previousStyles,
        ...context.styles,
        variables: {
          ...previousStyles?.variables,
          ...context.styles.variables,
        },
        css: {
          ...previousStyles?.css,
          ...context.styles.css,
        },
      };
    }

    if (context.deviceCapabilities) {
      merged.deviceCapabilities = {
        ...previousDeviceCapabilities,
        ...context.deviceCapabilities,
      };
    }

    if (context.safeAreaInsets) {
      merged.safeAreaInsets = mergeSafeAreaInsets(previousSafeAreaInsets, context.safeAreaInsets);
    }

    if (context.nteract) {
      merged.nteract = {
        ...previousNteract,
        ...context.nteract,
      };
    }
  }

  return merged;
}
