import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishIdentityHeaders } from "../scripts/publish-auth.mjs";

describe("publishIdentityHeaders", () => {
  it("uses Anaconda bearer auth without dev identity headers", () => {
    const headers = publishIdentityHeaders({
      bearerToken: "api-key",
      devAuthToken: "dev-token",
      operator: "agent:publish-test",
      scope: "owner",
      user: "demo",
    });

    assert.equal(headers.Authorization, "Bearer api-key");
    assert.equal(headers["X-Notebook-Cloud-Auth-Provider"], "anaconda-api-key");
    assert.equal(headers["X-Scope"], "owner");
    assert.equal(headers["X-Operator"], "agent:publish-test");
    assert.equal(headers["X-User"], undefined);
    assert.equal(headers["X-Notebook-Cloud-Dev-Token"], undefined);
  });

  it("uses dev identity headers when no bearer token is present", () => {
    const headers = publishIdentityHeaders({
      bearerToken: "",
      devAuthToken: "dev-token",
      operator: "agent:publish-test",
      scope: "owner",
      user: "demo",
    });

    assert.equal(headers.Authorization, undefined);
    assert.equal(headers["X-Notebook-Cloud-Auth-Provider"], undefined);
    assert.equal(headers["X-User"], "demo");
    assert.equal(headers["X-Operator"], "agent:publish-test");
    assert.equal(headers["X-Scope"], "owner");
    assert.equal(headers["X-Notebook-Cloud-Dev-Token"], "dev-token");
  });
});
