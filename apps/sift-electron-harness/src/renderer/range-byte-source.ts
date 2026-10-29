/**
 * A Sift `ByteSource` over the preload's `readRange`, the same shape as Kilo
 * Desktop's `createRangeByteSource` (anaconda/agentic-desktop
 * `origin/feat/files-parquet-preview`,
 * `plugins/files/src/web/files/table-viewer/range-byte-source.ts`).
 *
 * Every chunk is pinned to `revision`, so a file that changes mid-load fails
 * the read instead of mixing bytes from two versions. Reads larger than one
 * IPC call allows go out as sequential chunks, one in flight per read.
 */

import type { ByteSource } from "@nteract/sift";

import type { HarnessBridge } from "../shared/bridge";

export const READ_RANGE_LIMIT_BYTES = 16 * 1024 * 1024;
export const STALE_MESSAGE = "The file changed on disk while the table was loading.";

export type CreateRangeByteSourceOptions = {
  readonly readRange: HarnessBridge["readRange"];
  readonly path: string;
  readonly byteLength: number;
  /** Stat fingerprint main checks on every chunk. */
  readonly revision: string;
  readonly chunkLimitBytes?: number;
  /** Called once, on the first chunk main refuses because the file changed. */
  readonly onStale?: () => void;
  /** Called after each IPC chunk, for the harness's diagnostics. */
  readonly onChunk?: (offset: number, length: number) => void;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export function createRangeByteSource(options: CreateRangeByteSourceOptions): ByteSource {
  const { byteLength, readRange, path, revision } = options;
  const chunkLimit = options.chunkLimitBytes ?? READ_RANGE_LIMIT_BYTES;
  let stale = false;

  async function readChunk(
    offset: number,
    length: number,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const result = await readRange({ path, offset, length, expectedRevision: revision });
    // A read superseded mid-flight must neither deliver bytes nor report stale.
    if (signal?.aborted) throw abortReason(signal);
    if (result.status === "conflict") {
      if (!stale) {
        stale = true;
        options.onStale?.();
      }
      throw new Error(STALE_MESSAGE);
    }
    if (result.bytes.byteLength !== length) {
      throw new Error(
        `Read of ${path} at ${String(offset)} expected ${String(length)} bytes, got ${String(result.bytes.byteLength)}.`,
      );
    }
    options.onChunk?.(offset, length);
    return result.bytes;
  }

  return {
    byteLength,
    async read(offset, length, signal) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        offset + length > byteLength
      ) {
        throw new RangeError(
          `Range ${String(offset)}+${String(length)} is outside ${String(byteLength)} bytes.`,
        );
      }
      if (signal?.aborted) throw abortReason(signal);
      if (length === 0) return new Uint8Array(0);
      if (length <= chunkLimit) return readChunk(offset, length, signal);

      const bytes = new Uint8Array(length);
      for (let filled = 0; filled < length; ) {
        if (signal?.aborted) throw abortReason(signal);
        const chunk = await readChunk(
          offset + filled,
          Math.min(chunkLimit, length - filled),
          signal,
        );
        bytes.set(chunk, filled);
        filled += chunk.byteLength;
      }
      return bytes;
    },
  };
}
