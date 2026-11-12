// TEST-ONLY ENTRY: build.mjs never imports this file. The E2E runner bundles it
// into a temporary directory without a deployment receipt. Never deploy it.
//
// The sharing fixture Worker plus one route the unopened-page smoke uses:
// POST /__e2e/unopen?page=<id> stamps that Page's host record with document
// formats this build doesn't write, as a record from another version of
// Pages would be. The harness then restarts celld, so the Page host starts
// cold over the record and opens neither document.
import worker, { Page as PageHost } from "../../worker/index.mjs";
import { fixtureFetch } from "./local-api-keys.mjs";
export { Catalog, PageRecords, Space } from "../../worker/index.mjs";

const UNOPEN_PATH = "/__e2e/unopen";
// A Page document format no build writes (worker/document-types.test.mjs).
const UNWRITTEN_FORMATS = Object.freeze({ "pages.page": 99, "pages.comments": 2 });

export class Page extends PageHost {
  async fetch(request) {
    if (new URL(request.url).pathname !== UNOPEN_PATH) return super.fetch(request);
    await this.ready;
    const record = await this.ctx.storage.get("host/document");
    if (!record) return Response.json({ error: "No such Page" }, { status: 404 });
    const stamped = { ...record, documentFormats: UNWRITTEN_FORMATS };
    await this.ctx.storage.put("host/document", stamped);
    // Until the restart, nothing this host writes puts the old formats back.
    this.metadata = stamped;
    return Response.json({ page_id: record.pageId, documentFormats: UNWRITTEN_FORMATS });
  }
}

const origin = PAGES_E2E_ORIGIN;
globalThis.fetch = fixtureFetch(origin, PAGES_E2E_RESPONSES, globalThis.fetch.bind(globalThis));
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.origin !== origin || env.PAGES_E2E_ONLY !== "true")
      return new Response("Local test fixture only", { status: 403 });
    if (url.pathname === UNOPEN_PATH && request.method === "POST") {
      const pageId = url.searchParams.get("page");
      if (!pageId) return Response.json({ error: "page is required" }, { status: 400 });
      return env.PAGES.getByName(pageId).fetch(
        new Request(`${origin}${UNOPEN_PATH}`, { method: "POST" }),
      );
    }
    return worker.fetch(request, env, ctx);
  },
};
