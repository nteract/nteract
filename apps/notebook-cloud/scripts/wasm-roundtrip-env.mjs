export function assertWasmRoundtripAuthEnv({ baseUrl, devAuthToken }) {
  if (devAuthToken || isLoopbackBaseUrl(baseUrl)) {
    return;
  }

  throw new Error(
    "NOTEBOOK_CLOUD_DEV_TOKEN is required when NOTEBOOK_CLOUD_URL targets a deployed notebook-cloud host. Pass it through the environment; deployed dev credentials are intentionally not accepted in URLs.",
  );
}

export function isLoopbackBaseUrl(baseUrl) {
  const { hostname } = new URL(baseUrl);
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
