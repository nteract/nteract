import type { R2Object, R2ObjectBody } from "./cloudflare-types.ts";
import { DEV_AUTH_TOKEN_HEADER } from "./auth-shared.ts";

export function json(value: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export function withCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "DELETE, GET, HEAD, POST, PUT, OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    `Authorization, Content-Type, X-User, X-Principal, X-Operator, X-Scope, X-Viewer-Session, X-Runtime-Heads-Hash, X-Runtime-State-Doc-Id, ${DEV_AUTH_TOKEN_HEADER}`,
  );
  return response;
}

export function withBrowserSecurityHeaders(
  response: Response,
  contentSecurityPolicy?: string,
): Response {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set(
    "Permissions-Policy",
    [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "fullscreen=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "picture-in-picture=()",
      "publickey-credentials-get=()",
      "screen-wake-lock=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  );
  if (contentSecurityPolicy) {
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  }
  return response;
}

interface ImmutableR2ObjectOptions {
  includeContentLength?: boolean;
}

export function immutableR2ObjectHeaders(
  object: R2Object,
  options: ImmutableR2ObjectOptions = {},
): Headers {
  const headers = new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    ETag: object.httpEtag,
  });
  if (options.includeContentLength) {
    headers.set("Content-Length", object.size.toString());
  }
  return headers;
}

export function immutableR2ObjectResponse(
  object: R2ObjectBody,
  options: ImmutableR2ObjectOptions = {},
): Response {
  return withCors(
    new Response(object.body, { headers: immutableR2ObjectHeaders(object, options) }),
  );
}

export function immutableR2ObjectHeadResponse(object: R2Object): Response {
  return withCors(
    new Response(null, {
      headers: immutableR2ObjectHeaders(object, { includeContentLength: true }),
    }),
  );
}
