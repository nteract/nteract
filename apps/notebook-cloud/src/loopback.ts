export function isLoopbackWorkerRequest(
  request: Request,
  url = new URL(request.url),
  options: { trustHeaders?: boolean } = {},
): boolean {
  return (
    isLoopbackHostname(url.hostname) ||
    (options.trustHeaders === true &&
      (isLoopbackHostHeader(request.headers.get("Host")) ||
        isLoopbackHostname(request.headers.get("CF-Connecting-IP") ?? "")))
  );
}

export function trustsLoopbackRequestHeaders(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isLoopbackHostHeader(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) {
    return isLoopbackHostname(bracketedIpv6[1] ?? "");
  }
  return isLoopbackHostname(trimmed.replace(/:\d+$/, ""));
}
