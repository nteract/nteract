import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildCloudShareAccessRows,
  clearCloudShareAccessRowsCachesForTests,
  type CloudNotebookAccessRequest,
  type CloudNotebookAclRow,
} from "../sharing-client";

const TIMESTAMP = "2026-07-06T12:00:00.000Z";
const OPAQUE_SUBJECT = "01987654-3210-7def-8123-456789abcdef";

function aclRow(subject: string): CloudNotebookAclRow {
  return {
    notebook_id: "nb-1",
    subject_kind: "principal",
    subject,
    scope: "editor",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    created_by_actor_label: "user:dev:owner",
  };
}

function accessRequest(requesterPrincipal: string): CloudNotebookAccessRequest {
  return {
    id: "request-1",
    notebook_id: "nb-1",
    requester_principal: requesterPrincipal,
    scope: "editor",
    status: "pending",
    requested_by_actor_label: requesterPrincipal,
    resolved_by_actor_label: null,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    resolved_at: null,
  };
}

afterEach(() => {
  clearCloudShareAccessRowsCachesForTests();
});

describe("buildCloudShareAccessRows", () => {
  it("keeps opaque principal subjects out of sharing labels and titles", () => {
    const rows = buildCloudShareAccessRows({
      acl: [aclRow(OPAQUE_SUBJECT)],
      invites: [],
      accessRequests: [accessRequest(`user:anaconda:${OPAQUE_SUBJECT}`)],
    });

    const acl = rows.find((row) => row.kind === "acl");
    const request = rows.find((row) => row.kind === "access_request");

    expect(acl?.label).toBe("Collaborator");
    expect(acl?.detail).toBe("Collaborator");
    expect(acl?.title).toBe("Collaborator");
    expect(request?.label).toBe("Collaborator");
    expect(request?.title).toBe("Collaborator");
  });

  it("keeps readable dev handles and emails as sharing fallbacks", () => {
    const rows = buildCloudShareAccessRows({
      acl: [aclRow("user:dev:kyle")],
      invites: [],
      accessRequests: [accessRequest("user:anaconda:kyle%40example.com")],
    });

    const acl = rows.find((row) => row.kind === "acl");
    const request = rows.find((row) => row.kind === "access_request");

    expect(acl?.label).toBe("kyle");
    expect(acl?.detail).toBe("Dev identity");
    expect(acl?.title).toBe("kyle");
    expect(request?.label).toBe("k...e@example.com");
    expect(request?.title).toBe("kyle@example.com");
  });
});
