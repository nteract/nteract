import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldShowPrototypeDevControls } from "../viewer/prototype-dev-controls.ts";

describe("prototype dev controls visibility", () => {
  it("keeps dev controls visible when OIDC is not configured", () => {
    assert.equal(
      shouldShowPrototypeDevControls({
        oidcConfigured: false,
        hostname: "preview.runt.run",
        search: "",
      }),
      true,
    );
  });

  it("hides dev controls on deployed OIDC hosts by default", () => {
    assert.equal(
      shouldShowPrototypeDevControls({
        oidcConfigured: true,
        hostname: "preview.runt.run",
        search: "",
      }),
      false,
    );
  });

  it("allows explicit dev controls on deployed OIDC hosts", () => {
    for (const search of ["?notebook_cloud_dev_auth=1", "?dev_auth=true"]) {
      assert.equal(
        shouldShowPrototypeDevControls({
          oidcConfigured: true,
          hostname: "preview.runt.run",
          search,
        }),
        true,
      );
    }
  });

  it("keeps dev controls visible on local hosts", () => {
    for (const hostname of ["localhost", "app.localhost", "127.0.0.1", "::1"]) {
      assert.equal(
        shouldShowPrototypeDevControls({
          oidcConfigured: true,
          hostname,
          search: "",
        }),
        true,
      );
    }
  });
});
