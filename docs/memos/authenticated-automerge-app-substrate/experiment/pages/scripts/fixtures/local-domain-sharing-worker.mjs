// TEST-ONLY entry. Never imported by build.mjs or copied into a publication.
import worker from "../../worker/index.mjs";
import { createLocalOidcIssuer } from "@nteract/local-oidc";
import { fixtureFetch } from "./local-api-keys.mjs";
export { Page, Catalog, PageRecords, Space } from "../../worker/index.mjs";

const origin = PAGES_E2E_ORIGIN;
globalThis.fetch = fixtureFetch(origin, PAGES_E2E_RESPONSES, globalThis.fetch.bind(globalThis));
let issuer;
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.origin !== origin ||
      env.PAGES_E2E_ONLY !== "true" ||
      env.NOTEBOOK_CLOUD_LOCAL_OIDC !== "true"
    )
      return new Response("Local test fixture only", { status: 403 });
    if (url.pathname === "/dev/oidc" || url.pathname.startsWith("/dev/oidc/")) {
      issuer ??= createLocalOidcIssuer({
        issuerUrl: `${origin}/dev/oidc`,
        clientId: env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID,
        audience: env.NOTEBOOK_CLOUD_OIDC_AUDIENCE,
        defaultTokenTtlSeconds: 300,
        users: [
          { email: "dev@localhost", name: "Local Owner" },
          { email: "lead@anaconda.com", name: "Company Owner" },
          { email: "alice@localhost", name: "Invited Editor" },
          { email: "employee@anaconda.com", name: "Company Viewer" },
          { email: "blocked@anaconda.com", name: "Excluded Employee" },
          { email: "outsider@gmail.com", name: "Consumer Account" },
        ],
      });
      return issuer.handle(request);
    }
    return worker.fetch(request, env, ctx);
  },
};
