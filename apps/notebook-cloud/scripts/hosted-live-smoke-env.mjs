export function smokeEnvForPublishResult(env, publishResult) {
  assertPublishResultHasViewerUrl(publishResult);

  const smokeEnv = {
    ...env,
    NOTEBOOK_CLOUD_HOSTED_URL: publishResult.viewerUrl,
  };
  setRequiredDefaultEnv(
    smokeEnv,
    "NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH",
    publishResult.headsHash,
    "headsHash",
  );
  setRequiredDefaultEnv(
    smokeEnv,
    "NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH",
    publishResult.runtimeHeadsHash,
    "runtimeHeadsHash",
  );
  setRequiredDefaultEnv(
    smokeEnv,
    "NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_STATE_DOC_ID",
    publishResult.runtimeStateDocId,
    "runtimeStateDocId",
  );
  setOptionalDefaultEnv(
    smokeEnv,
    "NOTEBOOK_CLOUD_EXPECTED_CATALOG_OWNER_PRINCIPAL",
    publishResult.ownerPrincipal,
  );
  setOptionalDefaultEnv(
    smokeEnv,
    "NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_ACTOR_LABEL",
    publishResult.latestRevisionActorLabel,
  );
  applyLivePresetSmokeDefaults(smokeEnv, env, publishResult);

  if (!hasOwn(smokeEnv, "NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN")) {
    const origin = new URL(publishResult.viewerUrl).origin;
    if (isLoopbackOrigin(origin)) {
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN = origin;
    }
  }

  return smokeEnv;
}

export function assertPublishResultMatchesSource(env, publishResult) {
  const expectedSourceNotebookId = env.NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID;
  if (expectedSourceNotebookId && publishResult.sourceNotebookId !== expectedSourceNotebookId) {
    throw new Error(
      `publish-live exported source notebook ${publishResult.sourceNotebookId ?? "missing"}, expected ${expectedSourceNotebookId}`,
    );
  }
}

function assertPublishResultHasViewerUrl(publishResult) {
  if (!publishResult.viewerUrl) {
    throw new Error("publish-live output did not include viewerUrl");
  }
}

function setRequiredDefaultEnv(env, name, value, fieldName) {
  if (hasOwn(env, name)) {
    return;
  }
  if (!value) {
    throw new Error(`publish-live did not provide ${fieldName}; cannot pin catalog assertion`);
  }
  env[name] = value;
}

function setOptionalDefaultEnv(env, name, value) {
  if (hasOwn(env, name) || value === undefined || value === null) {
    return;
  }
  env[name] = value;
}

function applyLivePresetSmokeDefaults(smokeEnv, env, publishResult) {
  const preset =
    publishResult.preset === "source-notebook"
      ? env.NOTEBOOK_CLOUD_LIVE_PRESET
      : publishResult.preset;
  const defaults = livePresetSmokeDefaults(preset);
  if (!defaults) {
    return;
  }

  for (const [name, value] of Object.entries(defaults)) {
    setOptionalDefaultEnv(smokeEnv, name, value);
  }
}

function livePresetSmokeDefaults(preset) {
  if (preset === "mathnet") {
    return {
      NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT: "ShadenA/MathNet",
      NOTEBOOK_CLOUD_EXPECTED_PAGE_TEXTS: JSON.stringify([
        "MathNet topic visualization",
        "Loading the slice",
        "Loaded 25 rows",
      ]),
      NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS: "",
      NOTEBOOK_CLOUD_EXPECTED_PRESENCE_TITLE: "",
      NOTEBOOK_CLOUD_REQUIRE_SIFT_WASM: "0",
      NOTEBOOK_CLOUD_SMOKE_THEME_MODES: "",
    };
  }
  if (preset === "html-output") {
    return {
      NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT: "html-output-origin-probe",
      NOTEBOOK_CLOUD_EXPECTED_PAGE_TEXTS: JSON.stringify(["HTML output document origin smoke"]),
      NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS: JSON.stringify(["Hello from HTML output document"]),
      NOTEBOOK_CLOUD_EXPECTED_PRESENCE_TITLE: "",
      NOTEBOOK_CLOUD_REQUIRE_SIFT_WASM: "0",
    };
  }
  if (preset === "lets-edit") {
    return {
      NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT: "Let's edit",
      NOTEBOOK_CLOUD_EXPECTED_PAGE_TEXTS: JSON.stringify(["Let's edit", "Scratch space"]),
      NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS: "",
      NOTEBOOK_CLOUD_EXPECTED_PRESENCE_TITLE: "",
      NOTEBOOK_CLOUD_REQUIRE_SIFT_WASM: "0",
      NOTEBOOK_CLOUD_SMOKE_THEME_MODES: "",
    };
  }
  return null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isLoopbackOrigin(origin) {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
