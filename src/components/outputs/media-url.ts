export function isDirectMediaUrl(value: string): boolean {
  return /^(?:blob:|data:|https?:)/i.test(value) || value.startsWith("/");
}

export function mediaDataToSource(value: string, mediaType: string): string {
  return isDirectMediaUrl(value) ? value : `data:${mediaType};base64,${value}`;
}
