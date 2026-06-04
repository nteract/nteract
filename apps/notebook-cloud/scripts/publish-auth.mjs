export function publishIdentityHeaders({
  scope = "owner",
  operator,
  user,
  devAuthToken = process.env.NOTEBOOK_CLOUD_DEV_TOKEN,
  bearerToken = process.env.NTERACT_API_KEY ?? process.env.NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN,
} = {}) {
  if (bearerToken) {
    return {
      Authorization: `Bearer ${bearerToken}`,
      "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
      "X-Scope": scope,
      ...(operator ? { "X-Operator": operator } : {}),
    };
  }

  return {
    "X-User": user ?? "publisher",
    "X-Operator": operator ?? "agent:publish",
    "X-Scope": scope,
    ...devAuthHeaders(devAuthToken),
  };
}

function devAuthHeaders(devAuthToken) {
  return devAuthToken ? { "X-Notebook-Cloud-Dev-Token": devAuthToken } : {};
}
