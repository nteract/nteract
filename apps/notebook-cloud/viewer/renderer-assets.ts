export function rendererAssetBasePathForProvider(basePath: string): string {
  return basePath.trim().replace(/\/+$/, "");
}
