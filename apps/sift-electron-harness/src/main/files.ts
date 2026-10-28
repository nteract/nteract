/**
 * Bounded, revision-pinned file reads for the renderer, shaped like Kilo
 * Desktop's Files `readRange` (anaconda/agentic-desktop
 * `origin/feat/files-parquet-preview`,
 * `plugins/files/src/main/workspace-files/FilesService.ts`).
 *
 * The renderer names a file by the path `openFile` returned; only paths the
 * main process opened (the launch argument or a dialog pick) are readable.
 */

import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import type { OpenedFile, ReadRangeRequest, ReadRangeResult } from "../shared/bridge";

/** Largest slice one `readRange` call returns; KD's `READ_RANGE_LIMIT_BYTES`. */
export const READ_RANGE_LIMIT_BYTES = 16 * 1024 * 1024;

/** KD's stat fingerprint: any rewrite, truncate, or touch changes it. */
function statRevision(metadata: BigIntStats): string {
  return createHash("sha256")
    .update(
      `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`,
    )
    .digest("hex");
}

function validByteRange(offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= READ_RANGE_LIMIT_BYTES
  );
}

export type FileServiceOptions = {
  /** Delay every `readRange`, to make mid-load events deterministic in tests. */
  readDelayMs?: number;
};

export function createFileService(options: FileServiceOptions = {}) {
  const allowed = new Set<string>();

  function authorize(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (!allowed.has(resolved)) throw new Error(`Not an opened file: ${filePath}`);
    return resolved;
  }

  return {
    /** Make `filePath` readable by the renderer. Main-process only. */
    allow(filePath: string): string {
      const resolved = path.resolve(filePath);
      allowed.add(resolved);
      return resolved;
    },

    async openFile(filePath: string): Promise<OpenedFile> {
      const resolved = authorize(filePath);
      const metadata = await stat(resolved, { bigint: true });
      if (!metadata.isFile()) throw new Error(`Not a regular file: ${filePath}`);
      return {
        path: resolved,
        byteLength: Number(metadata.size),
        revision: statRevision(metadata),
      };
    },

    async stat(filePath: string): Promise<{ byteLength: number; revision: string }> {
      const metadata = await stat(authorize(filePath), { bigint: true });
      return { byteLength: Number(metadata.size), revision: statRevision(metadata) };
    },

    /**
     * `length` bytes at `offset` while the stat revision still matches
     * `expectedRevision`, checked before and after the read. A file that
     * changes during the read is a conflict, never a partial slice.
     */
    async readRange(request: ReadRangeRequest): Promise<ReadRangeResult> {
      const { offset, length, expectedRevision } = request;
      if (!validByteRange(offset, length)) {
        throw new Error(
          `Byte range ${String(offset)}+${String(length)} is invalid (max ${READ_RANGE_LIMIT_BYTES} bytes).`,
        );
      }
      const resolved = authorize(request.path);
      if (options.readDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.readDelayMs));
      }
      const handle = await open(resolved, "r");
      try {
        const before = await handle.stat({ bigint: true });
        const beforeRevision = statRevision(before);
        if (beforeRevision !== expectedRevision) {
          return { status: "conflict", diskRevision: beforeRevision };
        }
        if (offset + length > Number(before.size)) {
          throw new Error("Byte range extends past the end of the file.");
        }
        if (length === 0) return { status: "read", bytes: new Uint8Array(0) };

        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        const afterRevision = statRevision(await handle.stat({ bigint: true }));
        if (afterRevision !== expectedRevision) {
          return { status: "conflict", diskRevision: afterRevision };
        }
        if (filled < length) {
          throw new Error("File ended before the requested byte range completed.");
        }
        return {
          status: "read",
          bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        };
      } finally {
        await handle.close();
      }
    },
  };
}

export type FileService = ReturnType<typeof createFileService>;
