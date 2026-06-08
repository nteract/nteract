import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cloudOidcRenewalFailureMessage } from "../viewer/auth-renewal-copy.ts";

describe("cloud auth renewal copy", () => {
  it("asks the user to sign in again for expired provider refreshes", () => {
    assert.equal(
      cloudOidcRenewalFailureMessage(new Error("OIDC token refresh failed: 403")),
      "Sign in again to continue. Your browser session could not be refreshed.",
    );
  });

  it("keeps unexpected failures visible for diagnostics", () => {
    assert.equal(
      cloudOidcRenewalFailureMessage(new Error("OIDC discovery failed: 503")),
      "Unable to refresh sign-in: OIDC discovery failed: 503",
    );
  });
});
