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
  const latestRevisionNotebookHeadsHash =
    typeof latestRevision?.notebook_heads_hash === "string"
      ? latestRevision.notebook_heads_hash
      : null;
  const latestRevisionRuntimeHeadsHash =
    typeof latestRevision?.runtime_heads_hash === "string"
      ? latestRevision.runtime_heads_hash
      : null;
  const latestRevisionRuntimeStateDocId =
    typeof latestRevision?.runtime_state_doc_id === "string"
      ? latestRevision.runtime_state_doc_id
      : null;

  return {
    ownerPrincipal,
    latestRevisionId,
    latestRevisionActorLabel,
    latestRevisionNotebookHeadsHash,
    latestRevisionRuntimeHeadsHash,
    latestRevisionRuntimeStateDocId,
    revisionCount: revisions.length,
  };
}

export function catalogExpectationFailures(
  summary,
  {
    expectedCatalogOwnerPrincipal,
    expectedLatestRevisionActorLabel,
    expectedLatestRevisionNotebookHeadsHash,
    expectedLatestRevisionRuntimeHeadsHash,
    expectedLatestRevisionRuntimeStateDocId,
    requireLatestRevisionRuntimeStateDocId,
  },
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
  if (
    expectedLatestRevisionNotebookHeadsHash &&
    summary.latestRevisionNotebookHeadsHash !== expectedLatestRevisionNotebookHeadsHash
  ) {
    failures.push({
      text: `expected latest notebook heads ${expectedLatestRevisionNotebookHeadsHash}, got ${
        summary.latestRevisionNotebookHeadsHash ?? "missing"
      }`,
    });
  }
  if (
    expectedLatestRevisionRuntimeHeadsHash &&
    summary.latestRevisionRuntimeHeadsHash !== expectedLatestRevisionRuntimeHeadsHash
  ) {
    failures.push({
      text: `expected latest runtime heads ${expectedLatestRevisionRuntimeHeadsHash}, got ${
        summary.latestRevisionRuntimeHeadsHash ?? "missing"
      }`,
    });
  }
  if (requireLatestRevisionRuntimeStateDocId && !summary.latestRevisionRuntimeStateDocId) {
    failures.push({
      text: "expected latest revision runtime_state_doc_id, got missing",
    });
  }
  if (
    expectedLatestRevisionRuntimeStateDocId &&
    summary.latestRevisionRuntimeStateDocId !== expectedLatestRevisionRuntimeStateDocId
  ) {
    failures.push({
      text: `expected latest runtime_state_doc_id ${expectedLatestRevisionRuntimeStateDocId}, got ${
        summary.latestRevisionRuntimeStateDocId ?? "missing"
      }`,
    });
  }
  return failures;
}
