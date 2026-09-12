import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloudOidcRenewalFailureMessage,
  isTransientCloudOidcError,
} from "../viewer/auth-renewal-copy.ts";
import { OidcHttpError, OidcNetworkError, OidcTimeoutError } from "../viewer/oidc-auth.ts";

describe("cloud auth renewal copy", () => {
  it("asks the user to sign in again for a confirmed refresh-token rejection", () => {
    for (const status of [400, 401, 403]) {
      assert.equal(
        isTransientCloudOidcError(new OidcHttpError("token-exchange", status, "x")),
        false,
      );
      assert.equal(
        cloudOidcRenewalFailureMessage(new Error(`OIDC token refresh failed: ${status}`)),
        "Sign in again to continue. Your browser session could not be refreshed.",
      );
    }
  });

  it("keeps unexpected discovery failures visible for diagnostics", () => {
    assert.equal(
      cloudOidcRenewalFailureMessage(new Error("OIDC discovery failed: 503")),
      "Unable to refresh sign-in: OIDC discovery failed: 503",
    );
  });

  it("never tells the user to sign in again for a timeout: no server confirmed anything", () => {
    const error = new OidcTimeoutError("token-exchange");
    assert.equal(isTransientCloudOidcError(error), true);
    assert.equal(
      cloudOidcRenewalFailureMessage(error),
      "Couldn't reach the sign-in service. Retrying automatically.",
    );
  });

  it("never tells the user to sign in again for a network failure: the browser got nothing usable", () => {
    const error = new OidcNetworkError("discovery", new TypeError("Failed to fetch"));
    assert.equal(isTransientCloudOidcError(error), true);
    assert.equal(
      cloudOidcRenewalFailureMessage(error),
      "Couldn't reach the sign-in service. Retrying automatically.",
    );
  });

  it("never tells the user to sign in again for a 429 or 5xx from the token endpoint: the service is down, not the token", () => {
    for (const status of [429, 500, 502, 503]) {
      const typed = new OidcHttpError("token-exchange", status, "OIDC token refresh");
      assert.equal(isTransientCloudOidcError(typed), true);
      assert.equal(
        cloudOidcRenewalFailureMessage(typed),
        "The sign-in service is temporarily unavailable. Retrying automatically.",
      );
      // Also covers callers/tests that predate `OidcHttpError` and still throw
      // a plain `Error` with the historical message shape.
      const plain = new Error(`OIDC token refresh failed: ${status}`);
      assert.equal(isTransientCloudOidcError(plain), true);
      assert.equal(
        cloudOidcRenewalFailureMessage(plain),
        "The sign-in service is temporarily unavailable. Retrying automatically.",
      );
    }
  });

  it("does not classify a confirmed HTTP failure or stored-session error as transient", () => {
    assert.equal(isTransientCloudOidcError(new Error("OIDC token refresh failed: 403")), false);
    assert.equal(isTransientCloudOidcError(new Error("Stored OIDC session is missing.")), false);
  });
});
