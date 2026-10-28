// A real 3x2 PNG encoded by Pillow. The URL is synthetic: this fixture must
// intercept it locally, never attempt an OpenAI network request.
export const imageDownloadUrl =
  "https://files.oaiusercontent.com/file_pages_mcp_fixture?token=local-only";
export const imageFileId = "file_pages_mcp_fixture";
export const imagePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=";
export const imagePng = () => Uint8Array.from(atob(imagePngBase64), (char) => char.charCodeAt(0));

export function fixtureImageFetch(fallback) {
  const state = { downloads: 0, expired: false };
  return {
    state,
    async fetch(input, init) {
      const request = new Request(input, init);
      if (request.url !== imageDownloadUrl) return fallback(input, init);
      state.downloads++;
      if (
        request.method !== "GET" ||
        request.headers.has("authorization") ||
        request.headers.has("cookie")
      )
        throw new Error("Image fixture received an unexpected credential or method");
      return state.expired
        ? new Response("Expired fixture", { status: 403 })
        : new Response(imagePng(), { headers: { "Content-Type": "image/png" } });
    },
  };
}
