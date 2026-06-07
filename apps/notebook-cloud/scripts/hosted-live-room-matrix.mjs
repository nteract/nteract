export function parseLiveRoomMatrixEntries(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_URLS JSON must be an array");
    }
    return parsed.map((entry, index) => normalizeMatrixEntry(entry, index));
  }

  return trimmed
    .split(/\n|\|/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((url, index) => normalizeMatrixEntry(url, index));
}

export function normalizeMatrixEntry(entry, index = 0) {
  if (typeof entry === "string") {
    assertUrl(entry, `matrix entry ${index + 1}`);
    return { url: entry };
  }

  if (!isRecord(entry)) {
    throw new Error(`matrix entry ${index + 1} must be a URL string or object`);
  }

  if (typeof entry.url !== "string" || entry.url.length === 0) {
    throw new Error(`matrix entry ${index + 1} is missing url`);
  }
  assertUrl(entry.url, `matrix entry ${index + 1}`);

  return {
    ...entry,
    url: entry.url,
  };
}

export function smokeEnvForMatrixEntry(entry, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_TEXT: "",
    NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_PAGE_TEXTS: "",
    NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_FRAME_TEXTS: "",
    NOTEBOOK_CLOUD_LIVE_ROOM_MIN_CELLS: baseEnv.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_MIN_CELLS ?? "0",
    NOTEBOOK_CLOUD_LIVE_ROOM_MIN_VISIBLE_IFRAMES:
      baseEnv.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_MIN_VISIBLE_IFRAMES ?? "0",
    NOTEBOOK_CLOUD_LIVE_ROOM_MIN_IMAGES: baseEnv.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_MIN_IMAGES ?? "0",
    NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_BLOB_FETCH:
      baseEnv.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_REQUIRE_BLOB_FETCH ?? "0",
    NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_IMAGES_LOADED:
      baseEnv.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_REQUIRE_IMAGES_LOADED ?? "0",
  };

  setOptionalString(env, "NOTEBOOK_CLOUD_LIVE_ROOM_SCOPE", entry.scope);
  setOptionalString(env, "NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_TEXT", entry.expectedText);
  setOptionalTexts(env, "NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_PAGE_TEXTS", entry.expectedPageTexts);
  setOptionalTexts(env, "NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_FRAME_TEXTS", entry.expectedFrameTexts);
  setOptionalInteger(env, "NOTEBOOK_CLOUD_LIVE_ROOM_MIN_CELLS", entry.minCells);
  setOptionalInteger(env, "NOTEBOOK_CLOUD_LIVE_ROOM_MIN_VISIBLE_IFRAMES", entry.minVisibleIframes);
  setOptionalInteger(env, "NOTEBOOK_CLOUD_LIVE_ROOM_MIN_IMAGES", entry.minImages);
  setOptionalBoolean(env, "NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_RESOLVED", entry.requireResolved);
  setOptionalBoolean(env, "NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_OPEN_SOCKET", entry.requireOpenSocket);
  setOptionalBoolean(env, "NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_BLOB_FETCH", entry.requireBlobFetch);
  setOptionalBoolean(
    env,
    "NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_IMAGES_LOADED",
    entry.requireImagesLoaded,
  );

  return env;
}

export function entryLabel(entry, index = 0) {
  if (typeof entry.label === "string" && entry.label.trim()) {
    return entry.label.trim();
  }
  if (typeof entry.notebookId === "string" && entry.notebookId.trim()) {
    return entry.notebookId.trim();
  }
  try {
    const url = new URL(entry.url);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[1] ?? `notebook-${index + 1}`;
  } catch {
    return `notebook-${index + 1}`;
  }
}

export function safeScreenshotName(label, index = 0) {
  const compact = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${String(index + 1).padStart(2, "0")}-${compact || "notebook"}.png`;
}

function setOptionalString(env, name, value) {
  if (typeof value === "string") {
    env[name] = value;
  }
}

function setOptionalTexts(env, name, value) {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    env[name] = JSON.stringify(value);
    return;
  }
  if (typeof value === "string") {
    env[name] = value;
  }
}

function setOptionalInteger(env, name, value) {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} override must be a non-negative integer`);
  }
  env[name] = String(value);
}

function setOptionalBoolean(env, name, value) {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} override must be a boolean`);
  }
  env[name] = value ? "1" : "0";
}

function assertUrl(value, label) {
  try {
    new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
