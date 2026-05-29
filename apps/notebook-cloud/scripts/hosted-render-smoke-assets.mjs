export const VIEWER_CSS_MANIFEST_PATH = "/assets/notebook-cloud-viewer-css.json";
export const DEFAULT_PRIMARY_VIEWER_CSS_MAX_BYTES = 250_000;

export function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function isViewerCssAssetPath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/assets/") &&
    value.endsWith(".css") &&
    !value.includes("..") &&
    !value.includes("%")
  );
}

export function validateViewerCssManifestPayload(manifest, { minSupplementalCount = 1 } = {}) {
  const failures = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      primary: null,
      supplemental: [],
      failures: [{ kind: "viewer-css", text: "viewer CSS manifest was not an object" }],
    };
  }

  const primary = isViewerCssAssetPath(manifest.primary) ? manifest.primary : null;
  if (!primary) {
    failures.push({
      kind: "viewer-css",
      text: "viewer CSS manifest is missing a safe primary stylesheet path",
      value: manifest.primary ?? null,
    });
  }

  const supplementalInput = Array.isArray(manifest.supplemental) ? manifest.supplemental : [];
  if (!Array.isArray(manifest.supplemental)) {
    failures.push({
      kind: "viewer-css",
      text: "viewer CSS manifest is missing a supplemental stylesheet array",
    });
  }

  const supplemental = [];
  for (const value of supplementalInput) {
    if (isViewerCssAssetPath(value)) {
      supplemental.push(value);
      continue;
    }
    failures.push({
      kind: "viewer-css",
      text: "viewer CSS manifest included an unsafe supplemental stylesheet path",
      value,
    });
  }

  if (primary && supplemental.includes(primary)) {
    failures.push({
      kind: "viewer-css",
      text: "viewer CSS manifest listed the primary stylesheet as supplemental",
      value: primary,
    });
  }

  if (supplemental.length < minSupplementalCount) {
    failures.push({
      kind: "viewer-css",
      text: `expected at least ${minSupplementalCount} supplemental viewer CSS asset(s), got ${supplemental.length}`,
    });
  }

  return { primary, supplemental, failures };
}

export async function checkViewerCssSplit(
  viewerUrl,
  {
    fetchImpl = fetch,
    manifestPath = VIEWER_CSS_MANIFEST_PATH,
    maxPrimaryBytes = DEFAULT_PRIMARY_VIEWER_CSS_MAX_BYTES,
    minSupplementalCount = 1,
  } = {},
) {
  const origin = new URL(viewerUrl).origin;
  const manifestUrl = new URL(manifestPath, origin).href;
  const failures = [];

  const manifestResponse = await fetchImpl(manifestUrl);
  if (!manifestResponse.ok) {
    return {
      manifestUrl,
      manifestStatus: manifestResponse.status,
      primary: null,
      supplemental: [],
      primaryBytes: null,
      failures: [
        {
          kind: "viewer-css",
          text: `${manifestUrl} returned ${manifestResponse.status}`,
        },
      ],
    };
  }

  const manifest = await manifestResponse.json();
  const manifestCheck = validateViewerCssManifestPayload(manifest, { minSupplementalCount });
  failures.push(...manifestCheck.failures);

  let primaryBytes = null;
  let primaryStatus = null;
  let primaryContentType = null;
  if (manifestCheck.primary) {
    const primaryUrl = new URL(manifestCheck.primary, origin).href;
    const primaryResponse = await fetchImpl(primaryUrl);
    primaryStatus = primaryResponse.status;
    primaryContentType = primaryResponse.headers.get("content-type");
    if (!primaryResponse.ok) {
      failures.push({
        kind: "viewer-css",
        text: `${primaryUrl} returned ${primaryResponse.status}`,
      });
    } else {
      primaryBytes = (await primaryResponse.arrayBuffer()).byteLength;
      if (primaryBytes > maxPrimaryBytes) {
        failures.push({
          kind: "viewer-css",
          text: `primary viewer CSS was ${primaryBytes} bytes, expected <= ${maxPrimaryBytes}`,
          url: primaryUrl,
        });
      }
    }
    if (!primaryContentType?.includes("text/css")) {
      failures.push({
        kind: "viewer-css",
        text: `primary viewer CSS content type was ${primaryContentType ?? "missing"}`,
        url: primaryUrl,
      });
    }
  }

  const supplemental = [];
  for (const href of manifestCheck.supplemental) {
    const url = new URL(href, origin).href;
    const response = await fetchImpl(url, { method: "HEAD" });
    const status = response.status;
    const contentType = response.headers.get("content-type");
    supplemental.push({ href, url, status, contentType });
    if (!response.ok) {
      failures.push({ kind: "viewer-css", text: `${url} returned ${status}` });
    }
    if (!contentType?.includes("text/css")) {
      failures.push({
        kind: "viewer-css",
        text: `supplemental viewer CSS content type was ${contentType ?? "missing"}`,
        url,
      });
    }
  }

  return {
    manifestUrl,
    manifestStatus: manifestResponse.status,
    primary: manifestCheck.primary,
    primaryStatus,
    primaryContentType,
    primaryBytes,
    maxPrimaryBytes,
    supplemental,
    failures,
  };
}
