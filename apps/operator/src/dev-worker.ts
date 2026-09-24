// Separate development entry point. Never included by the production build.
import { createLocalOidcIssuer } from "../../../packages/local-oidc/src/index.ts";
import { createOperatorHandler } from "./worker.ts";
import type { OperatorEnvironment } from "./auth.ts";
import type { DurableObjectNamespace } from "../../notebook-cloud/src/cloudflare-types.ts";

const origin = "http://localhost:9470";
// celld may use different Worker isolates for the authorize and token calls.
// Keep this dev issuer's ephemeral keys/codes in one Durable Object instance.
export class LocalOperatorIssuer {
  private readonly issuer = createLocalOidcIssuer({
    issuerUrl: `${origin}/dev/oidc`,
    clientId: "local-operator",
    audience: "local-operator",
    users: { email: "operator@example.test", name: "Local operator" },
    allowRedirectUri: (uri) => uri === `${origin}/oidc`,
  });
  fetch(request: Request) {
    return this.issuer.handle(request);
  }
}
const app = createOperatorHandler(true);
export default {
  fetch(request: Request, env: OperatorEnvironment & { DEV_ISSUER: DurableObjectNamespace }) {
    const url = new URL(request.url);
    if (url.origin !== origin || env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN !== origin)
      return new Response("Local development only", { status: 403 });
    if (url.pathname.startsWith("/dev/oidc/"))
      return env.DEV_ISSUER.get(env.DEV_ISSUER.idFromName("local-issuer")).fetch(request);
    return app.fetch(request, env);
  },
};
