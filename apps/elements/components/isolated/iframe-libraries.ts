export interface RendererPluginTarget {
  installRenderer(code: string, css?: string): void;
}

export function needsPlugin(_mime: string): boolean {
  return false;
}

export function loadPluginForMime(_mime: string): Promise<undefined> {
  return Promise.resolve(undefined);
}

export function preWarmForMimes(_mimes: Iterable<string>): void {}

export async function injectPluginsForMimes(
  _frame: RendererPluginTarget,
  mimes: Iterable<string>,
  injectedSet: Set<string>,
): Promise<void> {
  for (const mime of mimes) {
    injectedSet.add(mime);
  }
}
