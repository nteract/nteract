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
      this: { items: Record<string, Blob> },
      items: Record<string, Blob>,
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

    await copyRasterImageToClipboard("data:image/png;base64,AQID", "image/png");

    expect(ClipboardItemMock).toHaveBeenCalledTimes(1);
    const itemPayload = ClipboardItemMock.mock.calls[0]?.[0] as Record<string, Blob>;
    const blob = itemPayload["image/png"];
    expect(blob.type).toBe("image/png");
    expect(await readBlobBytes(blob)).toEqual([1, 2, 3]);
    expect(write).toHaveBeenCalledWith([expect.any(ClipboardItemMock)]);
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

    await expect(
      copyRasterImageToClipboard("data:image/png;base64,AQID", "image/png"),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("[copy-image] Failed to copy raster image:", failure);
  });
});
