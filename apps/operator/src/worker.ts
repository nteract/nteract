import {
  beginServerOidcLogin,
  completeServerOidcLogin,
  deleteServerOidcSession,
  serverOidcSessionStatus,
} from "../../notebook-cloud/src/server-oidc.ts";
import { AuthError } from "../../notebook-cloud/src/identity.ts";
import {
  allowedEmails,
  authorizeOperator,
  requireAllowedIdentity,
  type OperatorEnvironment,
} from "./auth.ts";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const DATA_ROUTES = new Map([
  ["/api/operator/metrics", "/api/metrics"],
  ["/api/operator/export.json", "/export.json"],
  ["/api/operator/export.csv", "/export.csv"],
]);

function privateResponse(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("Content-Security-Policy", CSP);
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  return result;
}

function configurationFailure(field: string): never {
  console.warn(
    JSON.stringify({ service: "nteract-operator", event: "configuration_invalid", field }),
  );
  throw new AuthError("Operator service is not configured", 503);
}

function configured(env: OperatorEnvironment, request: Request, localDevelopment: boolean): string {
  let origin: URL;
  try {
    origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN ?? "");
  } catch {
    return configurationFailure("NOTEBOOK_CLOUD_PUBLIC_ORIGIN");
  }
  const local =
    localDevelopment &&
    origin.origin === "http://localhost:9470" &&
    new URL(request.url).origin === origin.origin &&
    env.NOTEBOOK_CLOUD_OIDC_ISSUER === `${origin.origin}/dev/oidc`;
  if (
    (!local && origin.protocol !== "https:") ||
    origin.origin !== env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN
  )
    configurationFailure("NOTEBOOK_CLOUD_PUBLIC_ORIGIN");
  if (env.NOTEBOOK_CLOUD_OIDC_FLOW !== "server") configurationFailure("NOTEBOOK_CLOUD_OIDC_FLOW");
  if (!local && env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true")
    configurationFailure("NOTEBOOK_CLOUD_LOCAL_OIDC");
  for (const field of [
    "DB",
    "NOTEBOOK_CLOUD_OIDC_ISSUER",
    "NOTEBOOK_CLOUD_OIDC_CLIENT_ID",
    "NOTEBOOK_CLOUD_OIDC_AUDIENCE",
    "NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE",
  ] as const)
    if (!env[field]) configurationFailure(field);
  if ((env.NOTEBOOK_CLOUD_APP_SESSION_SECRET?.length ?? 0) < 32)
    configurationFailure("NOTEBOOK_CLOUD_APP_SESSION_SECRET");
  try {
    allowedEmails(env);
  } catch {
    configurationFailure("OPERATOR_ALLOWED_EMAILS");
  }
  return origin.origin;
}

function metricsUrl(request: Request, env: OperatorEnvironment, path: string): URL {
  // This is a fixed local read service, never an arbitrary proxy or celld /state.
  const base = env.OPERATOR_METRICS_ORIGIN ?? "http://127.0.0.1:9464";
  if (base !== "http://127.0.0.1:9464") configurationFailure("OPERATOR_METRICS_ORIGIN");
  const input = new URL(request.url);
  if (
    [...input.searchParams.keys()].some((k) => !["hours", "preview"].includes(k)) ||
    input.searchParams.getAll("hours").length > 1 ||
    input.searchParams.getAll("preview").length > 1
  )
    throw new AuthError("Invalid metrics query", 400);
  const hours = Number(input.searchParams.get("hours") ?? "24");
  const preview = input.searchParams.get("preview") ?? "";
  if (
    ![1, 6, 24, 168, 336].includes(hours) ||
    (preview && !/^(main|pr-[1-9][0-9]{0,7})$/.test(preview))
  )
    throw new AuthError("Invalid metrics query", 400);
  const url = new URL(path, base);
  url.search = new URLSearchParams({ hours: String(hours), preview }).toString();
  return url;
}

async function route(
  request: Request,
  env: OperatorEnvironment,
  localDevelopment: boolean,
): Promise<Response> {
  const origin = configured(env, request, localDevelopment);
  const url = new URL(request.url);
  const site = request.headers.get("Sec-Fetch-Site");
  const allowedNavigation =
    request.method === "GET" &&
    ["/", "/operator", "/operator/", "/oidc"].includes(url.pathname) &&
    request.headers.get("Sec-Fetch-Mode") === "navigate" &&
    request.headers.get("Sec-Fetch-Dest") === "document";
  // TLS may terminate at a reverse proxy. Use the configured public origin,
  // never forwarded headers, to validate browser origins and create redirects.
  // Missing Fetch Metadata is a compatibility path, not proof of same origin;
  // session authorization and explicit Origin checks still apply.
  if (
    (request.headers.has("Origin") && request.headers.get("Origin") !== origin) ||
    // Preview subdomains are same-site but are not trusted application origins.
    (site !== null && site !== "same-origin" && site !== "none" && !allowedNavigation)
  )
    return new Response("Open this page from the operator site", { status: 403 });
  const sameOrigin = request.headers.get("Origin") === origin;
  const syncIdentity = async (identity: Parameters<typeof requireAllowedIdentity>[1]) =>
    requireAllowedIdentity(env, identity);
  if (url.pathname === "/api/operator/session" && request.method === "DELETE") {
    if (!sameOrigin) return new Response(null, { status: 403 });
    return deleteServerOidcSession(request, env);
  }
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  if (url.pathname === "/" || url.pathname === "/operator")
    return new Response(null, { status: 302, headers: { Location: `${origin}/operator/` } });
  if (url.pathname === "/api/auth/oidc/login") {
    const login = new URL(request.url);
    login.search = "return_to=%2Foperator%2F";
    return beginServerOidcLogin(new Request(login, request), env);
  }
  if (url.pathname === "/oidc") {
    const callback = await completeServerOidcLogin(request, env, syncIdentity);
    return callback.status === 400
      ? new Response(
          "Sign-in could not be completed. Return to the operator app and try again.",
          callback,
        )
      : callback;
  }
  if (url.pathname === "/api/operator/session") {
    const refreshed = await serverOidcSessionStatus(request, env, syncIdentity);
    if (refreshed.status !== 200) return refreshed;
    const operator = await authorizeOperator(request, env);
    const response = Response.json(operator);
    const cookie = refreshed.headers.get("Set-Cookie");
    if (cookie) response.headers.set("Set-Cookie", cookie);
    return response;
  }
  const upstreamPath = DATA_ROUTES.get(url.pathname);
  if (upstreamPath) {
    await authorizeOperator(request, env);
    const upstreamUrl = metricsUrl(request, env, upstreamPath);
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: upstreamPath.endsWith(".csv") ? "text/csv" : "application/json" },
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          service: "nteract-operator",
          event: "metrics_unavailable",
          reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network",
        }),
      );
      throw new AuthError("Metrics unavailable", 503);
    }
    if (!upstream.ok) {
      console.warn(
        JSON.stringify({
          service: "nteract-operator",
          event: "metrics_unavailable",
          status: upstream.status,
        }),
      );
      await upstream.body?.cancel();
      return Response.json({ error: "Metrics unavailable" }, { status: 503 });
    }
    // Forward only data and content type. Never cookies, redirects, credentials,
    // user headers, proxy targets, SQL, or requests to the deployment controller.
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstreamPath.endsWith(".csv")
          ? "text/csv; charset=utf-8"
          : "application/json",
        ...(upstreamPath.startsWith("/export")
          ? {
              "Content-Disposition": `attachment; filename="preview-metrics.${upstreamPath.endsWith(".csv") ? "csv" : "json"}"`,
            }
          : {}),
      },
    });
  }
  if (
    url.pathname === "/operator/" ||
    /^\/operator\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(url.pathname)
  ) {
    if (!env.ASSETS) throw new Error("Missing assets");
    const asset = new URL(request.url);
    asset.pathname = url.pathname === "/operator/" ? "/" : url.pathname.slice("/operator".length);
    asset.search = "";
    return env.ASSETS.fetch(new Request(asset, { method: "GET" }));
  }
  return new Response("Not found", { status: 404 });
}

// The production entry point never enables the local development issuer.
export function createOperatorHandler(localDevelopment = false) {
  return {
    async fetch(request: Request, env: OperatorEnvironment): Promise<Response> {
      try {
        return privateResponse(await route(request, env, localDevelopment));
      } catch (error) {
        if (!(error instanceof AuthError))
          console.warn(
            JSON.stringify({
              service: "nteract-operator",
              event: "request_failed",
              reason:
                error instanceof Error && error.name === "TimeoutError"
                  ? "timeout"
                  : "service_or_configuration",
            }),
          );
        return privateResponse(
          Response.json(
            { error: error instanceof AuthError ? error.message : "Operator service unavailable" },
            { status: error instanceof AuthError ? error.status : 503 },
          ),
        );
      }
    },
  };
}
export default createOperatorHandler();
