// TEST-ONLY ENTRY: build.mjs never imports this file. The E2E runner bundles it
// into a temporary directory without a deployment receipt. Never deploy it.
import worker from "../../worker/index.mjs";
import { fixtureFetch } from "./local-api-keys.mjs";
export { Page, Catalog, PageRecords } from "../../worker/index.mjs";

const origin = PAGES_E2E_ORIGIN;
globalThis.fetch = fixtureFetch(origin, PAGES_E2E_RESPONSES, globalThis.fetch.bind(globalThis));
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).origin !== origin || env.PAGES_E2E_ONLY !== "true")
      return new Response("Local test fixture only", { status: 403 });
    return worker.fetch(request, env, ctx);
  },
};
