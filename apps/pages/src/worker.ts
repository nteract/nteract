import { readAgentGrant, authorizeAgentOperation, manageAgentAccess } from "./agent-access.ts";
import {
  beginServerOidcLogin,
  completeServerOidcLogin,
  deleteServerOidcSession,
  serverOidcSessionStatus,
  type ServerOidcEnvironment,
} from "../../notebook-cloud/src/server-oidc.ts";
import {
  readServerAppSession,
  serverOidcEnabled,
} from "../../notebook-cloud/src/oidc-session-store.ts";
import { authenticateOidcRequest, AuthError } from "../../notebook-cloud/src/identity.ts";
import type { DurableObjectNamespace } from "../../notebook-cloud/src/cloudflare-types.ts";
import { createLocalOidcIssuer } from "@nteract/local-oidc";
import { CAPABILITIES } from "./workspace.ts";
import { PageError, json, readBody, requireValue } from "./errors.ts";
import { hash } from "./document.ts";
export { PagesWorkspace } from "./workspace.ts";

export interface Env extends ServerOidcEnvironment {
  PAGES_WORKSPACES: DurableObjectNamespace;
  PAGES_ALLOW_PROVIDER_BEARER?: string;
}
const issuers = new Map<string, ReturnType<typeof createLocalOidcIssuer>>();
const noProfile = async () => {};

export function assertSameOrigin(request: Request, env: Env): void {
  const origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin;
  if (request.headers.get("Origin") !== origin)
    throw new PageError("forbidden", "A same-origin request is required", 403);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const publicOrigin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || url.origin);
      if (url.pathname.startsWith("/dev/oidc/")) {
        const local = [url.hostname, publicOrigin.hostname].every((h) =>
          ["localhost", "127.0.0.1", "[::1]"].includes(h),
        );
        if (env.NOTEBOOK_CLOUD_LOCAL_OIDC !== "true" || !local)
          return json({ error: "Not found" }, 404);
        const issuerUrl = env.NOTEBOOK_CLOUD_OIDC_ISSUER!;
        let issuer = issuers.get(issuerUrl);
        if (!issuer) {
          issuer = createLocalOidcIssuer({
            issuerUrl,
            clientId: env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID!,
            users: [
              { email: "dev@localhost", givenName: "Local", familyName: "Developer" },
              { email: "alice@localhost", givenName: "Alice", familyName: "Example" },
            ],
          });
          issuers.set(issuerUrl, issuer);
        }
        return (await issuer.handle(request)) ?? json({ error: "Not found" }, 404);
      }
      if (url.pathname === "/api/auth/login") return beginServerOidcLogin(request, env);
      if (url.pathname === "/oidc") return completeServerOidcLogin(request, env, noProfile);
      if (url.pathname === "/api/auth/session") {
        if (request.method === "POST") {
          assertSameOrigin(request, env);
          return deleteServerOidcSession(request, env);
        }
        requireValue(request.method === "GET", "method_not_allowed", "Use GET or POST");
        const headers = new Headers(request.headers);
        headers.delete("X-Nteract-Session-Account-Key");
        const response = await serverOidcSessionStatus(
          new Request(request, { headers }),
          env,
          noProfile,
        );
        if (!response.ok) return response;
        const body = (await response.json()) as { session: Record<string, unknown> | null };
        const session = await readServerAppSession(env, request, Math.floor(Date.now() / 1000));
        if (body.session && session)
          body.session.account_key = await hash(
            JSON.stringify([env.NOTEBOOK_CLOUD_OIDC_ISSUER, session.principal]),
          );
        else body.session = null;
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: response.headers,
        });
      }
      if (url.pathname === "/api/agent") {
        requireValue(request.method === "GET", "method_not_allowed", "Use GET");
        const grant = await readAgentGrant(env, request);
        if (!grant)
          throw new PageError("unauthorized", "Connection is missing, expired or revoked", 401);
        return json({ connection: grant });
      }
      if (url.pathname === "/api/agent-connections") {
        if (request.method !== "GET") assertSameOrigin(request, env);
        return await manageAgentAccess(
          request,
          env,
          async (principal, pageId) => {
            const stub = env.PAGES_WORKSPACES.get(env.PAGES_WORKSPACES.idFromName(principal));
            const result = await stub.fetch(
              new Request("https://pages.internal/tools", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-pages-principal": principal },
                body: JSON.stringify({
                  operation: "read_page",
                  arguments: { page_id: pageId, include_content: false },
                }),
              }),
            );
            if (!result.ok) throw new PageError("not_found", "Page not found in your account", 404);
          },
          async (principal) => {
            const stub = env.PAGES_WORKSPACES.get(env.PAGES_WORKSPACES.idFromName(principal));
            await stub.fetch(
              new Request("https://pages.internal/recheck", {
                method: "POST",
                headers: { "x-pages-principal": principal },
              }),
            );
          },
        );
      }
      if (url.pathname === "/api/events") {
        requireValue(
          request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket",
          "invalid_request",
          "Use a WebSocket upgrade",
        );
        if (request.headers.has("Origin")) assertSameOrigin(request, env);
        const grant = await readAgentGrant(env, request);
        if (!grant)
          throw new PageError("unauthorized", "Connection is missing, expired or revoked", 401);
        authorizeAgentOperation(grant, {
          operation: "read_page",
          arguments: { page_id: url.searchParams.get("page") },
        });
        const stub = env.PAGES_WORKSPACES.get(env.PAGES_WORKSPACES.idFromName(grant.principal));
        return stub.fetch(
          new Request("https://pages.internal/events" + url.search, {
            headers: {
              Upgrade: "websocket",
              "x-pages-principal": grant.principal,
              Authorization: request.headers.get("Authorization")!,
            },
          }),
        );
      }
      if (url.pathname === "/api/capabilities") return json(CAPABILITIES);
      if (url.pathname === "/api/sync") {
        assertSameOrigin(request, env);
        requireValue(
          request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket",
          "invalid_request",
          "Use a WebSocket upgrade",
        );
        if (request.headers.has("Authorization"))
          throw new PageError("unauthorized", "Use this endpoint's session cookie", 401);
        const session = await readServerAppSession(env, request, Math.floor(Date.now() / 1000));
        if (!session) throw new PageError("unauthorized", "Sign in to sync Pages", 401);
        const principal = JSON.stringify([env.NOTEBOOK_CLOUD_OIDC_ISSUER, session.principal]);
        const headers = new Headers({
          Upgrade: "websocket",
          "x-pages-principal": principal,
          Cookie: request.headers.get("Cookie") ?? "",
        });
        const stub = env.PAGES_WORKSPACES.get(env.PAGES_WORKSPACES.idFromName(principal));
        return stub.fetch(new Request("https://pages.internal/sync" + url.search, { headers }));
      }
      if (url.pathname === "/api/tools") {
        requireValue(request.method === "POST", "method_not_allowed", "Use POST");
        let principal: string;
        const grant = await readAgentGrant(env, request);
        if (grant) {
          if (request.headers.has("Origin")) assertSameOrigin(request, env);
          const body = await readBody(request);
          authorizeAgentOperation(grant, body);
          const stub = env.PAGES_WORKSPACES.get(env.PAGES_WORKSPACES.idFromName(grant.principal));
          return stub.fetch(
            new Request("https://pages.internal/tools", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-pages-principal": grant.principal,
                Authorization: request.headers.get("Authorization")!,
              },
              body: JSON.stringify(body),
            }),
          );
        }
        if (request.headers.has("Authorization")) {
          // Shared OAuth clients issue tokens usable at multiple endpoints.
          // Match notebook-cloud: server-login deployments admit only their
          // own session, minted after this origin's state/PKCE exchange.
          if (serverOidcEnabled(env) || env.PAGES_ALLOW_PROVIDER_BEARER !== "true")
            throw new PageError(
              "unauthorized",
              "Use the server sign-in session for this endpoint",
              401,
            );
          const identity = await authenticateOidcRequest(request, env);
          principal = identity.principal;
          if (request.headers.has("Origin")) assertSameOrigin(request, env);
        } else {
          assertSameOrigin(request, env);
          const session = await readServerAppSession(env, request, Math.floor(Date.now() / 1000));
          if (!session) throw new PageError("unauthorized", "Sign in to access Pages", 401);
          principal = session.principal;
        }
        // Bind storage to the issuer as well as its admitted subject namespace.
        // Reconfiguring an issuer must not transfer the old account's Pages.
        const workspaceIdentity = JSON.stringify([env.NOTEBOOK_CLOUD_OIDC_ISSUER, principal]);
        const headers = new Headers({
          "Content-Type": request.headers.get("Content-Type") ?? "",
          "x-pages-principal": workspaceIdentity,
        });
        // Client-supplied identity headers never cross this boundary.
        const stub = env.PAGES_WORKSPACES.get(env.PAGES_WORKSPACES.idFromName(workspaceIdentity));
        return stub.fetch(
          new Request("https://pages.internal/tools", {
            method: "POST",
            headers,
            body: request.body,
            duplex: "half",
          } as RequestInit),
        );
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "Viewer assets are missing; run the build" }, 503);
    } catch (error) {
      if (error instanceof PageError || error instanceof AuthError)
        return json(
          {
            error: {
              code: error instanceof PageError ? error.code : "unauthorized",
              message: error.message,
              commit_status: "not_committed",
            },
          },
          error.status,
        );
      return json(
        {
          error: {
            code: "service_unavailable",
            message: "Pages is temporarily unavailable",
            commit_status: "unknown",
          },
        },
        503,
      );
    }
  },
};
