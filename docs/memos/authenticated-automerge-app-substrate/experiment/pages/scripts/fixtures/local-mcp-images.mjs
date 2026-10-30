// A real 3x2 PNG encoded by Pillow. The download URLs are synthetic: the
// fixture Worker intercepts them and never attempts an OpenAI network request.
export const imageFileId = "file_pages_mcp_fixture";
export const imagePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=";
export const imagePng = () => Uint8Array.from(atob(imagePngBase64), (char) => char.charCodeAt(0));

// Every download URL carries its own token, and the token names the behavior
// the image source serves for it. No fixture state decides the response: celld
// serves gateway requests from a pool of isolates and swaps them, so anything
// held in one isolate's memory is invisible to the next request.
export const imageBehaviors = Object.freeze(["ok", "expired"]);
const imageUrlPrefix = `https://files.oaiusercontent.com/${imageFileId}?token=`;
const tokenPattern = new RegExp(
  `^(${imageBehaviors.join("|")})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);

export function imageDownloadUrl(behavior, token = crypto.randomUUID()) {
  if (!imageBehaviors.includes(behavior)) throw new Error(`Unknown image behavior: ${behavior}`);
  return imageUrlPrefix + `${behavior}-${token}`;
}

/** `{ token, behavior }` for a well-formed fixture token, or null. */
export function parseImageToken(token) {
  const match = typeof token === "string" ? tokenPattern.exec(token) : null;
  return match ? { token, behavior: match[1] } : null;
}

export function imageTokenOf(url) {
  return url.startsWith(imageUrlPrefix) ? parseImageToken(url.slice(imageUrlPrefix.length)) : null;
}

// Worker side. Downloads go to the loopback image source the smoke runs, which
// counts them and checks the fixture identity, so a request from another
// fixture build or a stale Worker fails the smoke instead of passing silently.
export function fixtureImageFetch(fallback, { source, identity, isolate, realFetch }) {
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith("https://files.oaiusercontent.com/")) return fallback(input, init);
    const parsed = imageTokenOf(request.url);
    if (!parsed) throw new Error("Image fixture received an unknown download URL");
    if (
      request.method !== "GET" ||
      request.headers.has("authorization") ||
      request.headers.has("cookie")
    )
      throw new Error("Image fixture received an unexpected credential or method");
    return realFetch(`${source}/download/${parsed.token}`, {
      headers: { "X-Pages-E2E-Fixture": identity, "X-Pages-E2E-Isolate": isolate },
      signal: request.signal,
    });
  };
}
