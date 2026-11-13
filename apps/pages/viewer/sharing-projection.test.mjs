import assert from "node:assert/strict";
import test from "node:test";
import {
  domainSharingProjection,
  linkAccessProjection,
  organizationSharingProjection,
} from "./sharing-projection.mjs";

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
test("a stored company domain grant carries its role, viewer when it names none", () => {
  const at = (domainView) => linkAccessProjection({ ...owner, domainView });
  assert.equal(domainSharingProjection(owner).role, null);
  assert.equal(at(null).role, null);
  assert.equal(at({ domain: "anaconda.com" }).role, "viewer");
  for (const role of ["viewer", "commenter", "editor"]) {
    const view = at({ domain: "anaconda.com", role });
    assert.equal(view.domain, "anaconda.com");
    assert.equal(view.role, role);
    assert.equal(view.organization, null);
  }
  assert.equal(at({ domain: "anaconda.com", role: "owner" }).role, "viewer");
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

const acme = { id: "org-acme", name: "Acme Research" };
const organizationOwner = {
  access: { canManageAccess: true },
  domainOptions: [],
  domainView: null,
  organizationOptions: [acme],
  organizationProof: { [acme.id]: "verified" },
  organizationAccess: null,
};
test("organization link access offers only proven organizations, keyed so no domain can collide", () => {
  const view = organizationSharingProjection(organizationOwner);
  assert.equal(view.selected, "");
  assert.deepEqual(view.options, [
    {
      value: "org:org-acme",
      label: "Anyone in Acme Research with the link",
      disabled: false,
      id: acme.id,
    },
  ]);
  assert.equal(
    organizationSharingProjection({
      ...organizationOwner,
      organizationOptions: [{ id: "a:b", name: "Colon" }],
    }).options[0].value,
    "org:a%3Ab",
  );
  for (const value of [
    { ...organizationOwner, organizationOptions: [] },
    { ...organizationOwner, organizationOptions: undefined },
    { ...organizationOwner, organizationOptions: [{ id: "", name: "x" }, { id: "y" }] },
    { ...organizationOwner, access: { canManageAccess: false } },
  ])
    assert.equal(organizationSharingProjection(value), null);
  assert.equal(
    organizationSharingProjection({
      ...organizationOwner,
      organizationOptions: [acme, { ...acme, name: "Again" }],
    }).options.length,
    1,
  );
});
test("a stored organization the owner can't prove stays visible, flagged and withdrawable", () => {
  const stored = { ...acme, role: "editor" };
  const proven = organizationSharingProjection({
    ...organizationOwner,
    organizationAccess: stored,
    organizationAccessOwnerVerified: true,
  });
  assert.equal(proven.selected, "org:org-acme");
  assert.deepEqual(proven.stored, stored);
  assert.equal(proven.unverified, false);
  for (const [proof, expired] of [
    ["expired", acme.name],
    ["missing", null],
  ]) {
    const lapsed = organizationSharingProjection({
      ...organizationOwner,
      organizationOptions: [],
      organizationProof: { [acme.id]: proof },
      organizationAccess: stored,
      organizationAccessOwnerVerified: false,
    });
    assert.equal(lapsed.selected, "org:org-acme");
    assert.equal(lapsed.unverified, true);
    assert.equal(lapsed.expired, expired);
    assert.equal(lapsed.options[0].disabled, true);
  }
});
test("one Link access control lists Restricted, organizations, then domains, one kind at a time", () => {
  const both = {
    ...organizationOwner,
    domainOptions: ["anaconda.com"],
    domainProof: { "anaconda.com": "verified" },
  };
  const open = linkAccessProjection(both);
  assert.deepEqual(
    open.options.map(({ value, kind, disabled }) => [value, kind, disabled]),
    [
      ["", undefined, false],
      ["org:org-acme", "organization", false],
      ["anaconda.com", "domain", false],
    ],
  );
  assert.equal(open.selected, "");
  const organizationSet = linkAccessProjection({
    ...both,
    organizationAccess: { ...acme, role: "commenter" },
    organizationAccessOwnerVerified: true,
  });
  assert.equal(organizationSet.selected, "org:org-acme");
  assert.deepEqual(organizationSet.organization, { ...acme, role: "commenter" });
  assert.equal(organizationSet.options.find(({ kind }) => kind === "domain").disabled, true);
  const domainSet = linkAccessProjection({
    ...both,
    domainView: { domain: "anaconda.com" },
    domainViewOwnerVerified: true,
  });
  assert.equal(domainSet.selected, "anaconda.com");
  assert.equal(domainSet.domain, "anaconda.com");
  assert.equal(domainSet.options.find(({ kind }) => kind === "organization").disabled, true);
  assert.equal(linkAccessProjection({ access: { canManageAccess: true } }), null);
  assert.deepEqual(
    linkAccessProjection({
      ...organizationOwner,
      organizationOptions: [],
      organizationProof: { [acme.id]: "expired" },
      organizationAccess: { ...acme, role: "viewer" },
      organizationAccessOwnerVerified: false,
    }).expired,
    { kind: "organization", name: acme.name },
  );
});
