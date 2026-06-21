export const CURSOR_COLORS = [
  "#2563eb", // blue
  "#e11d48", // rose
  "#d97706", // amber
  "#059669", // emerald
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
] as const;

/** Deterministic color from peer ID. */
export function peerColor(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

/**
 * Reduce an actor label to its durable identity key: principal plus operator
 * kind/name, without the per-connection or per-device instance id.
 */
export function identityColorKey(actorLabel: string): string {
  const slash = actorLabel.indexOf("/");
  if (slash === -1) return actorLabel;
  const principal = actorLabel.slice(0, slash);
  const operator = actorLabel.slice(slash + 1);
  const segments = operator.split(":");
  const kind = segments[0];
  const operatorKey =
    kind === "agent" || kind === "runtime" || kind === "system"
      ? segments.slice(0, 2).join(":")
      : kind;
  return `${principal}/${operatorKey}`;
}

/** Deterministic color for an actor's durable identity. */
export function colorForActorIdentity(actorLabel: string): string {
  return peerColor(identityColorKey(actorLabel));
}

type RgbColor = { red: number; green: number; blue: number };

const DARK_FOREGROUND = "#111827";
const LIGHT_FOREGROUND = "#ffffff";

/** Choose the higher-contrast foreground for a hex color background. */
export function readableForegroundForColor(color: string): "#ffffff" | "#111827" {
  const background = parseHexColor(color);
  if (!background) return LIGHT_FOREGROUND;

  const backgroundLuminance = relativeLuminance(background);
  const lightContrast = contrastRatio(backgroundLuminance, 1);
  const darkContrast = contrastRatio(
    backgroundLuminance,
    relativeLuminance({ red: 17, green: 24, blue: 39 }),
  );

  return darkContrast > lightContrast ? DARK_FOREGROUND : LIGHT_FOREGROUND;
}

function parseHexColor(color: string): RgbColor | null {
  const value = color.trim();
  const shorthand = /^#([0-9a-f]{3})$/i.exec(value);
  if (shorthand) {
    const [red, green, blue] = shorthand[1]
      .split("")
      .map((channel) => parseInt(channel + channel, 16));
    return { red, green, blue };
  }

  const full = /^#([0-9a-f]{6})$/i.exec(value);
  if (!full) return null;

  const hex = full[1];
  return {
    red: parseInt(hex.slice(0, 2), 16),
    green: parseInt(hex.slice(2, 4), 16),
    blue: parseInt(hex.slice(4, 6), 16),
  };
}

function relativeLuminance(color: RgbColor): number {
  const red = linearizedChannel(color.red);
  const green = linearizedChannel(color.green);
  const blue = linearizedChannel(color.blue);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function linearizedChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(firstLuminance: number, secondLuminance: number): number {
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Readable foreground (white or near-black) for an actor's identity color.
 *  Pairs with `colorForActorIdentity` so any surface that paints with an actor's
 *  color can pick legible text/icons without recomputing luminance per render. */
export function contrastColorForActorIdentity(actorLabel: string): "#ffffff" | "#111827" {
  return readableForegroundForColor(colorForActorIdentity(actorLabel));
}
