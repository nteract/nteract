export function onBehalfOfText(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? ` for ${trimmed}` : "";
}
