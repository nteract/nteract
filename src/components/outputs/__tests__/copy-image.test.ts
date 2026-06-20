import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { logger } from "@/lib/logger";
import { copyRasterImageToClipboard } from "../copy-image";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn() },
}));

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");

function readBlobBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

afterEach(() => {
  vi.restoreAllMocks();

  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as Partial<Navigator>).clipboard;
  }

  if (originalClipboardItem) {
    Object.defineProperty(globalThis, "ClipboardItem", originalClipboardItem);
  } else {
    delete (globalThis as Partial<typeof globalThis>).ClipboardItem;
  }
});

describe("copyRasterImageToClipboard", () => {
  it("writes a base64 data URL image through ClipboardItem", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const ClipboardItemMock = vi.fn(function ClipboardItem(
      this: { items: Record<string, Promise<Blob> | Blob> },
      items: Record<string, Promise<Blob> | Blob>,
    ) {
      this.items = items;
    });

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: ClipboardItemMock,
    });

    // Synchronous call: write() must be invoked inside the gesture, with the
    // blob deferred as a promise so the user activation is not lost.
    copyRasterImageToClipboard("data:image/png;base64,AQID", "image/png");

    expect(ClipboardItemMock).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith([expect.any(ClipboardItemMock)]);
    const itemPayload = ClipboardItemMock.mock.calls[0]?.[0] as Record<
      string,
      Promise<Blob> | Blob
    >;
    const value = itemPayload["image/png"];
    expect(typeof (value as Promise<Blob>).then).toBe("function");
    const blob = await value;
    expect(blob.type).toBe("image/png");
    expect(await readBlobBytes(blob)).toEqual([1, 2, 3]);
  });

  it("logs and swallows clipboard failures", async () => {
    const failure = new Error("denied");
    const write = vi.fn().mockRejectedValue(failure);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: vi.fn(function ClipboardItem() {}),
    });

    copyRasterImageToClipboard("data:image/png;base64,AQID", "image/png");
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith("[copy-image] Failed to copy raster image:", failure);
  });
});
