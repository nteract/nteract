export interface PrototypeDevControlsVisibilityInput {
  oidcConfigured: boolean;
  hostname: string;
  search: string;
}

export function shouldShowPrototypeDevControls({
  oidcConfigured,
  hostname,
  search,
}: PrototypeDevControlsVisibilityInput): boolean {
  if (!oidcConfigured) {
    return true;
  }

  const params = new URLSearchParams(search);
  const explicit = params.get("notebook_cloud_dev_auth") ?? params.get("dev_auth");
  if (explicit === "1" || explicit === "true") {
    return true;
  }

  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}
