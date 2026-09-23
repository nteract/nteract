export function createOutputPreparer(options: {
  prepareContent(mime: string, json: string): { inline?: string; bytes?: number[] };
  putBlob(blob: { hash: string; bytes: Uint8Array; mediaType: string }): Promise<unknown>;
}): (outputs: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
