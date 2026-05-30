export interface GutterColorConfig {
  ribbon: {
    default: string;
    focused: string;
  };
  outputRibbon: {
    default: string;
    focused: string;
  };
  background: {
    focused: string;
  };
}

/**
 * Default ribbon colors for built-in cell types.
 * Colors are designed to keep cell-type ribbons visually consistent.
 */
export const defaultGutterColors: Record<string, GutterColorConfig> = {
  code: {
    ribbon: {
      default: "bg-gray-200/75 dark:bg-gray-700/70",
      focused: "bg-sky-400/80 dark:bg-sky-600/80",
    },
    outputRibbon: {
      default:
        "bg-gradient-to-b from-gray-200/30 to-gray-200/65 dark:from-gray-700/30 dark:to-gray-700/65",
      focused:
        "bg-gradient-to-b from-sky-400/30 to-sky-400/70 dark:from-sky-600/35 dark:to-sky-600/75",
    },
    background: {
      focused: "bg-sky-50/20 dark:bg-sky-900/10",
    },
  },
  markdown: {
    ribbon: {
      default: "bg-gray-200/75 dark:bg-gray-700/70",
      focused: "bg-emerald-400/80 dark:bg-emerald-600/80",
    },
    outputRibbon: {
      default:
        "bg-gradient-to-b from-gray-200/30 to-gray-200/65 dark:from-gray-700/30 dark:to-gray-700/65",
      focused:
        "bg-gradient-to-b from-emerald-400/30 to-emerald-400/70 dark:from-emerald-600/35 dark:to-emerald-600/75",
    },
    background: {
      focused: "bg-emerald-50/20 dark:bg-emerald-900/10",
    },
  },
  sql: {
    ribbon: {
      default: "bg-amber-200/75 dark:bg-amber-800/70",
      focused: "bg-amber-400/80 dark:bg-amber-600/80",
    },
    outputRibbon: {
      default:
        "bg-gradient-to-b from-amber-200/30 to-amber-200/65 dark:from-amber-800/30 dark:to-amber-800/65",
      focused:
        "bg-gradient-to-b from-amber-400/30 to-amber-400/70 dark:from-amber-600/35 dark:to-amber-600/75",
    },
    background: {
      focused: "bg-amber-50/20 dark:bg-amber-900/10",
    },
  },
  ai: {
    ribbon: {
      default: "bg-purple-200/75 dark:bg-purple-800/70",
      focused: "bg-purple-400/80 dark:bg-purple-600/80",
    },
    outputRibbon: {
      default:
        "bg-gradient-to-b from-purple-200/30 to-purple-200/65 dark:from-purple-800/30 dark:to-purple-800/65",
      focused:
        "bg-gradient-to-b from-purple-400/30 to-purple-400/70 dark:from-purple-600/35 dark:to-purple-600/75",
    },
    background: {
      focused: "bg-purple-50/20 dark:bg-purple-900/10",
    },
  },
  raw: {
    ribbon: {
      default: "bg-gray-200/75 dark:bg-gray-700/70",
      focused: "bg-rose-400/80 dark:bg-rose-600/80",
    },
    outputRibbon: {
      default:
        "bg-gradient-to-b from-gray-200/30 to-gray-200/65 dark:from-gray-700/30 dark:to-gray-700/65",
      focused:
        "bg-gradient-to-b from-rose-400/30 to-rose-400/70 dark:from-rose-600/35 dark:to-rose-600/75",
    },
    background: {
      focused: "bg-rose-50/20 dark:bg-rose-900/10",
    },
  },
};

/**
 * Fallback colors for unknown cell types.
 * Uses neutral gray styling.
 */
export const fallbackGutterColors: GutterColorConfig = {
  ribbon: {
    default: "bg-gray-200/75 dark:bg-gray-700/70",
    focused: "bg-gray-400/80 dark:bg-gray-500/80",
  },
  outputRibbon: {
    default:
      "bg-gradient-to-b from-gray-200/30 to-gray-200/65 dark:from-gray-700/30 dark:to-gray-700/65",
    focused:
      "bg-gradient-to-b from-gray-400/30 to-gray-400/70 dark:from-gray-500/35 dark:to-gray-500/75",
  },
  background: {
    focused: "bg-gray-50/50 dark:bg-gray-900/30",
  },
};

/**
 * Get ribbon colors for a cell type.
 * Falls back to neutral gray for unknown types.
 *
 * @param cellType - The cell type to get colors for
 * @param customColors - Optional custom color overrides
 */
export function getGutterColors(
  cellType: string,
  customColors?: Record<string, GutterColorConfig>,
): GutterColorConfig {
  // Check custom colors first
  if (customColors?.[cellType]) {
    return customColors[cellType];
  }
  // Then check defaults
  if (defaultGutterColors[cellType]) {
    return defaultGutterColors[cellType];
  }
  // Fall back to neutral
  return fallbackGutterColors;
}
