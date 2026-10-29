// Official npm release; its published SLSA provenance binds this tarball to the
// tagged upstream source. npm ci verifies the tarball integrity in package-lock.
export const subductionRelease = Object.freeze({
  version: "0.26.0",
  repository: "https://github.com/inkandswitch/subduction",
  revision: "dce952aac6d85506eeb0235facbb8132b39bb95c",
  tag: "subduction-js-v0.26.0",
  minimizationFix: "239c5fc125619d345be4015d186b91ac587306ad",
  tarballIntegrity:
    "sha512-uycgMB6A60wfY2+wE3P2M/vwcELsGnVLezX2SMNdo90qFkhueLoHN5IAB/asAXgHzAof8NREvKYdwSrNWBoJwQ==",
  wasmSha256: "c769ae1fa385d73159af94331886201a4cfd5e23d6c5110dd1676ab17da9c8cb",
});

// The pinned Repo checkout still requests 0.23.0. Rewrite the generated package
// as well as the checked-in experiment and Pages manifests, so npm cannot install
// a second native runtime inside the adapter workspace.
export function pinSubductionDependency(pkg) {
  const current = pkg.dependencies?.["@automerge/subduction"];
  if (current === undefined) return;
  if (current !== "0.23.0" && current !== subductionRelease.version) {
    throw new Error(`Unexpected upstream Subduction dependency ${current}`);
  }
  pkg.dependencies["@automerge/subduction"] = subductionRelease.version;
}
