import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { tableResponse } from "./table-response";

afterEach(() => vi.unstubAllGlobals());

describe("tableResponse", () => {
  it.each([
    ["data:application/vnd.apache.arrow.stream;base64,AP+A", [0, 255, 128]],
    ["data:application/vnd.apache.parquet;base64,UEFSMQ==", [80, 65, 82, 49]],
    ["data:application/octet-stream,%00%ff%80", [0, 255, 128]],
    ["DATA:application/octet-stream;BASE64,%2B%2F8%3D", [251, 255]],
    ["data:application/octet-stream;base64,AP+A#fragment", [0, 255, 128]],
    ["data:application/octet-stream,a?b", [97, 63, 98]],
  ])("decodes embedded bytes without fetching: %s", async (url, expected) => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("CSP blocked fetch")));
    vi.stubGlobal("fetch", fetchMock);

    const response = await tableResponse(url);

    expect(response.ok).toBe(true);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the declared MIME type for Arrow/Parquet format detection", async () => {
    const response = await tableResponse("data:application/vnd.apache.parquet;base64,UEFSMQ==");
    expect(response.headers.get("Content-Type")).toBe("application/vnd.apache.parquet");
  });

  it.each(["data:application/octet-stream", "data:application/octet-stream;base64,%%%"])(
    "rejects malformed embedded data without fetching: %s",
    async (url) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(tableResponse(url)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["/table.arrow", "https://blobs.example/table.arrow", "blob:https://example/id"])(
    "preserves the normal fetch path: %s",
    async (url) => {
      const response = new Response(null, { status: 404 });
      const fetchMock = vi.fn(async () => response);
      vi.stubGlobal("fetch", fetchMock);
      expect(await tableResponse(url)).toBe(response);
      expect(fetchMock).toHaveBeenCalledWith(url);
    },
  );
});
