export interface WidgetBlobInliningOptions {
  isAllowedBlobUrl: (url: string) => boolean;
  fetchImpl?: typeof fetch;
}

export async function inlineWidgetBlobUrls(
  state: Record<string, unknown>,
  paths: {
    textPaths?: string[][];
    bufferPaths?: string[][];
  },
  options: WidgetBlobInliningOptions,
): Promise<void> {
  await Promise.all([
    inlineTextBlobUrls(state, paths.textPaths, options),
    inlineBufferBlobUrls(state, paths.bufferPaths, options),
  ]);
}

async function inlineTextBlobUrls(
  state: Record<string, unknown>,
  textPaths: string[][] | undefined,
  options: WidgetBlobInliningOptions,
): Promise<void> {
  if (!textPaths || textPaths.length === 0) return;
  await Promise.all(
    textPaths.map(async (path) => {
      const response = await fetchPath(state, path, options);
      if (!response) return;
      writePath(state, path, await response.text());
    }),
  );
}

async function inlineBufferBlobUrls(
  state: Record<string, unknown>,
  bufferPaths: string[][] | undefined,
  options: WidgetBlobInliningOptions,
): Promise<void> {
  if (!bufferPaths || bufferPaths.length === 0) return;
  await Promise.all(
    bufferPaths.map(async (path) => {
      const response = await fetchPath(state, path, options);
      if (!response) return;
      writePath(state, path, new DataView(await response.arrayBuffer()));
    }),
  );
}

async function fetchPath(
  state: Record<string, unknown>,
  path: string[],
  options: WidgetBlobInliningOptions,
): Promise<Response | null> {
  const url = readPath(state, path);
  if (typeof url !== "string") return null;
  if (!options.isAllowedBlobUrl(url)) return null;
  try {
    const response = await (options.fetchImpl ?? fetch)(url);
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(value: Record<string, unknown>, path: string[], next: unknown): void {
  if (path.length === 0) return;
  let current: Record<string, unknown> = value;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (typeof child !== "object" || child === null) return;
    current = child as Record<string, unknown>;
  }
  current[path[path.length - 1]] = next;
}
