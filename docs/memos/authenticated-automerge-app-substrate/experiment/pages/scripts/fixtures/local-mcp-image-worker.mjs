// TEST-ONLY ENTRY: build.mjs never imports this file. Only the local E2E runner
// bundles it in temporary storage without a deployable build receipt.
import worker from "../../worker/index.mjs";
import { fixtureFetch } from "./local-api-keys.mjs";
import { fixtureImageFetch } from "./local-mcp-images.mjs";
export { Page, Catalog, PageRecords, Space } from "../../worker/index.mjs";

const origin = PAGES_E2E_ORIGIN;
const images = fixtureImageFetch(
  fixtureFetch(origin, PAGES_E2E_RESPONSES, globalThis.fetch.bind(globalThis)),
);
globalThis.fetch = images.fetch;
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.origin !== origin || env.PAGES_E2E_ONLY !== "true")
      return new Response("Local test fixture only", { status: 403 });
    if (url.pathname === "/__e2e/image-source") {
      if (request.method === "POST") images.state.expired = true;
      else if (request.method !== "GET") return new Response(null, { status: 405 });
      return Response.json(images.state);
    }
    return worker.fetch(request, env, ctx);
  },
};
