import assert from "node:assert/strict";
import test from "node:test";
import { domainSharingProjection } from "./sharing-projection.mjs";

const owner = {
  access: { canManageAccess: true },
  domainOptions: ["anaconda.com"],
  domainView: null,
};
test("domain link access is restricted until the host reports an explicit Page grant", () => {
  const view = domainSharingProjection(owner);
  assert.equal(view.selected, "");
  assert.deepEqual(view.options, [
    { value: "", label: "Restricted" },
    { value: "anaconda.com", label: "Anyone at anaconda.com with the link" },
  ]);
  assert.equal(
    domainSharingProjection({ ...owner, domainView: { domain: "anaconda.com" } }).selected,
    "anaconda.com",
  );
});
test("owner or provider email never invents domain options; nonowners cannot configure link access", () => {
  for (const email of ["owner@gmail.com", "owner@outlook.com", "owner@anaconda.com"]) {
    assert.equal(domainSharingProjection({ access: owner.access, owner: { email } }), null);
  }
  assert.equal(domainSharingProjection({ ...owner, domainOptions: [] }), null);
  assert.equal(domainSharingProjection({ ...owner, access: { canManageAccess: false } }), null);
  assert.equal(domainSharingProjection(undefined), null);
});
test("unavailable stored domains and duplicate host choices cannot create an extra option", () => {
  const view = domainSharingProjection({
    ...owner,
    domainOptions: ["anaconda.com", "anaconda.com"],
    domainView: { domain: "gmail.com" },
  });
  assert.equal(view.selected, "");
  assert.equal(view.options.length, 2);
  assert.equal(
    view.options.some(({ value }) => value === "gmail.com"),
    false,
  );
});
