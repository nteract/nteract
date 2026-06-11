import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizedBuildSha, resolveBuildSha, withBuildShaVar } from "../scripts/deploy-main.mjs";

describe("notebook cloud main Worker deploy script", () => {
  it("injects the current build SHA into the wrangler vars block", () => {
    const config = `name = "nteract-notebook-cloud"

[vars]
DEPLOYMENT_ENV = "prototype"
`;

    assert.equal(
      withBuildShaVar(config, "ABCDEF1234567"),
      `name = "nteract-notebook-cloud"

[vars]
DEPLOYMENT_ENV = "prototype"
NOTEBOOK_CLOUD_BUILD_SHA = "abcdef1234567"
`,
    );
  });

  it("replaces an existing build SHA var", () => {
    const config = `[vars]
DEPLOYMENT_ENV = "prototype"
NOTEBOOK_CLOUD_BUILD_SHA = "1111111"
`;

    assert.equal(
      withBuildShaVar(config, "2222222"),
      `[vars]
DEPLOYMENT_ENV = "prototype"
NOTEBOOK_CLOUD_BUILD_SHA = "2222222"
`,
    );
  });

  it("adds a vars block when a config does not have one", () => {
    assert.equal(
      withBuildShaVar('name = "nteract-notebook-cloud"\n', "abcdef0"),
      `name = "nteract-notebook-cloud"

[vars]
NOTEBOOK_CLOUD_BUILD_SHA = "abcdef0"
`,
    );
  });

  it("rejects malformed build SHAs", () => {
    assert.throws(() => normalizedBuildSha("not-a-sha"), /7-40 character hexadecimal git SHA/);
  });

  it("uses explicit build SHA env before shelling out to git", async () => {
    const sha = await resolveBuildSha({ NOTEBOOK_CLOUD_BUILD_SHA: "ABCDEF0" }, async () => {
      throw new Error("git should not be called");
    });

    assert.equal(sha, "abcdef0");
  });
});
