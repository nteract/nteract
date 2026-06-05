export function appendEndpointPathSegment(endpoint: string, segment: string): string {
  const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${base}/${encodeURIComponent(segment)}`;
}

export async function cloudResponseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) {
      return new Error(`${fallback}: ${body.error}`);
    }
  } catch {
    // Ignore malformed error responses and fall back to the HTTP status.
  }
  return new Error(`${fallback}: ${response.status}`);
}
