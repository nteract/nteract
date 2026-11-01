// Build identity shared by the Worker and the viewer bundle.
//
// scripts/build.mjs defines __PAGES_BUILD__ as the first 12 hex characters of
// the source fingerprint, in both bundles of one build. Unbundled code (unit
// tests, tsx) reports "dev", which never asks a tab to reload.
//
// VIEWER_PROTOCOL is the contract this viewer speaks. MIN_VIEWER_PROTOCOL is
// the oldest viewer contract this Worker asks browser tabs to edit with. It is
// advice to viewers that read it, not server enforcement: older viewers and API
// clients ignore it. The README's Build updates section says when a server
// compatibility path may go. Raise VIEWER_PROTOCOL to at least the same value
// in the same change, or the new viewer would refuse itself. Integers only;
// never lower either value.
//
// Protocol 2: Markdown import writes no preserved blocks, strikethrough and
// horizontal rules are native, and the Page host converts stored preserved
// blocks. A protocol 1 viewer can still write a preserved block.
export const VIEWER_PROTOCOL = 2;
export const MIN_VIEWER_PROTOCOL = 2;

/* global __PAGES_BUILD__ */
export const PAGES_BUILD =
  typeof __PAGES_BUILD__ === "string" && /^[0-9a-f]{12}$/.test(__PAGES_BUILD__)
    ? __PAGES_BUILD__
    : "dev";

export const BUILD_HEADER = "X-Pages-Build";
export const MIN_VIEWER_PROTOCOL_HEADER = "X-Pages-Min-Viewer-Protocol";

/** Public build facts. A short source hash; nothing secret. */
export const buildAdvertisement = () => ({
  build: PAGES_BUILD,
  minViewerProtocol: MIN_VIEWER_PROTOCOL,
});

const validBuild = (value) => typeof value === "string" && /^(?:[0-9a-f]{12}|dev)$/.test(value);
const validProtocol = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000;

/** Normalize an advertisement from /health JSON or response headers.
 * Returns null when it carries no usable fact; one malformed field does not
 * discard the other. */
export function readAdvertisement(value) {
  if (!value || typeof value !== "object") return null;
  const build = validBuild(value.build) ? value.build : undefined;
  const minimum =
    typeof value.minViewerProtocol === "string"
      ? /^\d{1,7}$/.test(value.minViewerProtocol)
        ? Number(value.minViewerProtocol)
        : undefined
      : value.minViewerProtocol;
  const minViewerProtocol = validProtocol(minimum) ? minimum : undefined;
  if (build === undefined && minViewerProtocol === undefined) return null;
  return { build, minViewerProtocol };
}

export function advertisementFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  return readAdvertisement({
    build: headers.get(BUILD_HEADER) ?? undefined,
    minViewerProtocol: headers.get(MIN_VIEWER_PROTOCOL_HEADER) ?? undefined,
  });
}

const severity = { current: 0, update: 1, required: 2 };

/** Compare this viewer with what the Worker advertises.
 * - "required": the Worker no longer serves this viewer's protocol.
 * - "update": a different build is live; reloading is optional.
 * - "current": same build, or not enough information to say otherwise.
 * A "dev" build on either side never counts as different. */
export function compareBuild(server, { build = PAGES_BUILD, protocol = VIEWER_PROTOCOL } = {}) {
  const advertised = readAdvertisement(server);
  if (!advertised) return "current";
  if (advertised.minViewerProtocol !== undefined && advertised.minViewerProtocol > protocol)
    return "required";
  if (
    advertised.build !== undefined &&
    advertised.build !== "dev" &&
    build !== "dev" &&
    advertised.build !== build
  )
    return "update";
  return "current";
}

/** States only escalate during one tab's life. During a rolling deploy two
 * hosts can disagree; the banner must not flicker between them. */
export const strongerBuildState = (left, right) =>
  severity[right] > severity[left] ? right : left;
