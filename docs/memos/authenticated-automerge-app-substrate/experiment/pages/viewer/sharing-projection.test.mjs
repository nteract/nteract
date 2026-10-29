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
    { value: "", label: "Restricted", disabled: false },
    { value: "anaconda.com", label: "Anyone at anaconda.com with the link", disabled: false },
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
test("a stored company audience the owner cannot prove stays visible, flagged and withdrawable", () => {
  const legacy = {
    ...owner,
    domainOptions: [],
    domainView: { domain: "anaconda.com" },
    domainViewOwnerVerified: false,
  };
  const view = domainSharingProjection(legacy);
  assert.equal(view.selected, "anaconda.com");
  assert.equal(view.unverified, true);
  assert.equal(view.expired, null);
  assert.deepEqual(view.options, [
    { value: "", label: "Restricted", disabled: false },
    { value: "anaconda.com", label: "Anyone at anaconda.com with the link", disabled: true },
  ]);
  const proven = domainSharingProjection({
    ...owner,
    domainView: { domain: "anaconda.com" },
    domainViewOwnerVerified: true,
  });
  assert.equal(proven.unverified, false);
  assert.equal(proven.selected, "anaconda.com");
  // Without the host's flag, an unoffered stored domain is not surfaced.
  assert.equal(
    domainSharingProjection({
      ...owner,
      domainOptions: [],
      domainView: { domain: "anaconda.com" },
    }),
    null,
  );
  assert.equal(domainSharingProjection({ ...legacy, access: { canManageAccess: false } }), null);
});
test("expired company proof keeps the company choice visible but disabled; missing proof shows nothing", () => {
  const expired = domainSharingProjection({
    ...owner,
    domainOptions: [],
    domainProof: { "anaconda.com": "expired" },
  });
  assert.equal(expired.selected, "");
  assert.equal(expired.expired, "anaconda.com");
  assert.equal(expired.unverified, false);
  assert.deepEqual(expired.options, [
    { value: "", label: "Restricted", disabled: false },
    { value: "anaconda.com", label: "Anyone at anaconda.com with the link", disabled: true },
  ]);
  const storedExpired = domainSharingProjection({
    ...owner,
    domainOptions: [],
    domainProof: { "anaconda.com": "expired" },
    domainView: { domain: "anaconda.com" },
    domainViewOwnerVerified: false,
  });
  assert.equal(storedExpired.selected, "anaconda.com");
  assert.equal(storedExpired.expired, "anaconda.com");
  assert.equal(storedExpired.unverified, true);
  assert.equal(storedExpired.options.length, 2);
  assert.equal(
    domainSharingProjection({
      ...owner,
      domainOptions: [],
      domainProof: { "anaconda.com": "missing" },
    }),
    null,
  );
  const verified = domainSharingProjection({
    ...owner,
    domainProof: { "anaconda.com": "verified" },
  });
  assert.equal(verified.expired, null);
  assert.equal(verified.options[1].disabled, false);
});
