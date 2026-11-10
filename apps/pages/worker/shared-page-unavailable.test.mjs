import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogFixture, id, member, viewerAcl, at } from "./catalog-fixture.mjs";

// A listing that meets a shared Page that does not answer refuses with a
// stable, retryable code and a wait, never a bare 503.
for (const index of ["1", null])
  test(`a shared Page that is overloaded or unavailable refuses the listing as shared_page_unavailable (index: ${index})`, async (t) => {
    t.mock.method(console, "error", () => {});
    const f = await catalogFixture(t, { index });
    const shared = f.addPage(id(300), "Shared plan", viewerAcl);
    const answer = shared.fetch;
    await f.catalog(member).ctx.storage.put(`shared/${id(300)}`, {
      page_id: id(300),
      title: "Shared plan",
      created_at: at(1),
      updated_at: at(1),
      shared: true,
    });
    const refusal = async (fault, waits) => {
      shared.fetch = fault;
      const { status, body } = await f.listRaw(member);
      assert.equal(status, 503);
      assert.equal(body.code, "shared_page_unavailable");
      assert.equal(body.retryable, true);
      assert.ok(waits.includes(body.retry_after_ms), String(body.retry_after_ms));
      assert.match(body.error, /Retry the listing/);
    };
    const overloaded = Object.assign(Error("Durable Object is overloaded."), { overloaded: true });
    await refusal(() => Promise.reject(overloaded), [2000, 3000, 4000, 5000]);
    await refusal(
      () => Promise.reject(Object.assign(Error("Network connection lost."), { retryable: true })),
      [1000],
    );
    await refusal(async () => Response.json({ error: "busy" }, { status: 503 }), [1000]);
    shared.fetch = answer;
    const { body } = await f.list(member);
    assert.deepEqual(
      body.pages.map((page) => page.title),
      ["Shared plan"],
    );
  });

test("the listing refusal carries Retry-After", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = await catalogFixture(t);
  const shared = f.addPage(id(301), "Shared", viewerAcl);
  await f.catalog(member).ctx.storage.put(`shared/${id(301)}`, {
    page_id: id(301),
    title: "Shared",
    created_at: at(1),
    updated_at: at(1),
    shared: true,
  });
  shared.fetch = () => Promise.reject(Object.assign(Error("overloaded"), { overloaded: true }));
  const response = await f.catalog(member).fetch(
    new Request("https://pages.invalid/internal/catalog", {
      method: "POST",
      headers: { authorization: `Bearer ${f.auth.apiKey({ userId: "member" })}` },
      body: JSON.stringify({ operation: "list_pages", arguments: {} }),
    }),
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(response.headers.get("retry-after"), String(body.retry_after_ms / 1000));
});
