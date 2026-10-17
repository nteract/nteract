export class PageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function requireValue(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new PageError(code, message);
}

export function object(value: unknown): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_request",
    "Expected an object",
  );
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, limit = 262144): string {
  requireValue(
    typeof value === "string" && new TextEncoder().encode(value).length <= limit,
    "invalid_request",
    `Invalid ${name}`,
  );
  return value;
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  requireValue(
    request.headers.get("content-type")?.split(";")[0] === "application/json",
    "invalid_request",
    "Use application/json",
  );
  const reader = request.body?.getReader();
  requireValue(reader, "invalid_request", "Missing request body");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 300000) throw new PageError("request_too_large", "Request exceeds 300 KB", 413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof PageError) throw error;
    throw new PageError("invalid_json", "Invalid JSON");
  }
}
