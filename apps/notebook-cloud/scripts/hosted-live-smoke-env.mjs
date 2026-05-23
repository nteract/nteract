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

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isLoopbackOrigin(origin) {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
