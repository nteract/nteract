export function summarizeCatalog(json) {
  const ownerPrincipal =
    typeof json?.notebook?.owner_principal === "string" ? json.notebook.owner_principal : null;
  const latestRevisionId =
    typeof json?.notebook?.latest_revision_id === "string"
      ? json.notebook.latest_revision_id
      : null;
  const revisions = Array.isArray(json?.revisions) ? json.revisions : [];
  const latestRevision = latestRevisionId
    ? (revisions.find((revision) => revision?.id === latestRevisionId) ?? null)
    : null;
  const latestRevisionActorLabel =
    typeof latestRevision?.actor_label === "string" ? latestRevision.actor_label : null;

  return {
    ownerPrincipal,
    latestRevisionId,
    latestRevisionActorLabel,
    revisionCount: revisions.length,
  };
}

export function catalogExpectationFailures(
  summary,
  { expectedCatalogOwnerPrincipal, expectedLatestRevisionActorLabel },
) {
  const failures = [];
  if (expectedCatalogOwnerPrincipal && summary.ownerPrincipal !== expectedCatalogOwnerPrincipal) {
    failures.push({
      text: `expected catalog owner ${expectedCatalogOwnerPrincipal}, got ${
        summary.ownerPrincipal ?? "missing"
      }`,
    });
  }
  if (
    expectedLatestRevisionActorLabel &&
    summary.latestRevisionActorLabel !== expectedLatestRevisionActorLabel
  ) {
    failures.push({
      text: `expected latest revision actor ${expectedLatestRevisionActorLabel}, got ${
        summary.latestRevisionActorLabel ?? "missing"
      }`,
    });
  }
  return failures;
}
