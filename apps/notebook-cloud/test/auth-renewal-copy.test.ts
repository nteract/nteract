import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloudOidcRenewalFailureMessage,
  isCloudOidcNetworkError,
} from "../viewer/auth-renewal-copy.ts";
import { OidcNetworkError, OidcTimeoutError } from "../viewer/oidc-auth.ts";

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

  it("never tells the user to sign in again for a timeout: no server confirmed anything", () => {
    const error = new OidcTimeoutError("token-exchange");
    assert.equal(isCloudOidcNetworkError(error), true);
    assert.equal(
      cloudOidcRenewalFailureMessage(error),
      "Couldn't reach the sign-in service. Retrying automatically.",
    );
  });

  it("never tells the user to sign in again for a network failure: the request never landed", () => {
    const error = new OidcNetworkError("discovery", new TypeError("Failed to fetch"));
    assert.equal(isCloudOidcNetworkError(error), true);
    assert.equal(
      cloudOidcRenewalFailureMessage(error),
      "Couldn't reach the sign-in service. Retrying automatically.",
    );
  });

  it("does not classify a confirmed HTTP failure or stored-session error as a network error", () => {
    assert.equal(isCloudOidcNetworkError(new Error("OIDC token refresh failed: 403")), false);
    assert.equal(isCloudOidcNetworkError(new Error("Stored OIDC session is missing.")), false);
  });
});
