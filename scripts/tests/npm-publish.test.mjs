import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {runInNewContext} from "node:vm";

const workflow = readFileSync(new URL("../../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const sourceManifest = JSON.parse(readFileSync(new URL("../../packages/runtimed-node/package.json", import.meta.url), "utf8"));
const armPackage = "@runtimed/node-linux-arm64-gnu";

function step(name) {
  const value = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - |\n  [a-z]/)[0];
  assert.ok(value, `missing step ${name}`);
  return value;
}

function runManifestStep(name, manifest, enabled) {
  const code = step(name).split("          node <<'NODE'\n")[1]?.split("          NODE")[0];
  assert.ok(code, `missing Node script in ${name}`);
  let result = structuredClone(manifest);
  runInNewContext(code, {
    process: {env: {NPM_LINUX_ARM64_ENABLED: enabled, RUNNER_TEMP: "/tmp"}},
    require(name) {
      assert.equal(name, "node:fs");
      return {
        readFileSync() { return JSON.stringify(result); },
        writeFileSync(_path, contents) { result = JSON.parse(contents); },
      };
    },
  });
  return result;
}

for (const enabled of [undefined, "false", "true"]) {
  test(`wrapper includes ARM64 only after bootstrap (gate=${enabled})`, () => {
    const selected = runManifestStep("Select enabled wrapper platforms", sourceManifest, enabled);
    assert.equal(Boolean(selected.optionalDependencies[armPackage]), enabled === "true");
    for (const [name, version] of Object.entries(sourceManifest.optionalDependencies)) {
      if (name !== armPackage) assert.equal(selected.optionalDependencies[name], version);
    }
    // pnpm replaces workspace references when packing; validate the resulting
    // manifest with the same script that guards the uploaded release tarball.
    for (const name of Object.keys(selected.optionalDependencies)) selected.optionalDependencies[name] = selected.version;
    assert.doesNotThrow(() => runManifestStep("Verify wrapper package manifest", selected, enabled));
    const mismatched = structuredClone(selected);
    if (enabled === "true") delete mismatched.optionalDependencies[armPackage];
    else mismatched.optionalDependencies[armPackage] = selected.version;
    assert.throws(() => runManifestStep("Verify wrapper package manifest", mismatched, enabled), /publication gate/);
  });
}

test("only Linux ARM64 publication is gated; native failures still block the wrapper", () => {
  assert.match(step("Publish platform package"), /^        if: matrix\.target != 'linux-arm64-gnu' \|\| vars\.NPM_LINUX_ARM64_ENABLED == 'true'$/m);
  assert.match(workflow, /  pack-wrapper:\n    name: Pack wrapper package\n    needs: \[publish-native\]/);
  assert.doesNotMatch(workflow, /continue-on-error:|if: always\(\)/);
  assert.ok(workflow.indexOf("- name: Select enabled wrapper platforms") < workflow.indexOf("- name: Pack wrapper package"));
});
