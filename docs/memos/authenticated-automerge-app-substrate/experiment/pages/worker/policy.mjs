import { pageAccess, pageDecision, pageGrant } from "./access.mjs";
import { withAdmissionReason } from "./admission-reasons.mjs";

export class PermissionDenied extends Error {
  constructor(message = "Document access denied", code = "page_access_denied") {
    super(message);
    this.status = 403;
    this.code = code;
  }
}

/** An inherited lease requires a fresh policy resolution, not a new credential. */
export function leaseExpiryError(identity, deadline) {
  return deadline < identity.expiresAt && deadline !== identity.domainAccess?.expiresAt
    ? withAdmissionReason(
        Object.assign(new Error("Project authority lease expired"), {
          status: 503,
          code: "project_policy_unavailable",
        }),
        "project_lease_expired",
      )
    : credentialExpired();
}

export function credentialExpired() {
  const error = new PermissionDenied(
    "Document access denied: credential expired",
    "credential_expired",
  );
  error.status = 401;
  return error;
}

/** The owner gets a conflict for writes. Members learn only that the Page is
 * in Trash; anyone without a grant sees an ordinary denial.
 */
export function pageTrashed(access, grant) {
  if (access.canRead)
    return Object.assign(new Error("This Page is in Trash; restore it before changing it"), {
      status: 409,
      code: "page_trashed",
    });
  return ["viewer", "commenter", "editor"].includes(grant?.role)
    ? withAdmissionReason(
        new PermissionDenied("This Page is in its owner's Trash", "page_trashed"),
        "page_trashed",
      )
    : withAdmissionReason(new PermissionDenied(), "page_no_grant");
}

/** A Page's access decisions, from its host record. One ACL governs the
 * Page and its comments document. The CRDT never grants access.
 * `metadata()` is the record as the host currently enforces it. */
export class DocumentPolicy {
  constructor({ metadata, now = Date.now }) {
    this.metadata = metadata;
    this.now = now;
  }

  /** `write` is false to read, true to edit the Page, or "comment" to write
   * its comments document. */
  account(identity, write = false) {
    const access = pageAccess(this.metadata(), identity, { now: this.now() });
    if (access.trashed && (!access.canRead || write))
      throw pageTrashed(access, pageGrant(this.metadata(), identity?.principal));
    if (!access.canRead) throw this.readDenied(identity);
    const comment = write === "comment";
    if (write && !comment && this.metadata()?.recoveryBlocked)
      throw Object.assign(
        new Error("Page recovery is blocked; accepted content is available read-only"),
        { status: 409, code: "page_recovery_blocked" },
      );
    if (write && !identity.canWrite) throw new PermissionDenied("Credential is read-only");
    if (comment && !access.canComment)
      throw new PermissionDenied("Commenting is not allowed on this Page");
    if (write && !comment && !access.canWrite) throw new PermissionDenied("Page is read-only");
    return access;
  }

  /** Classify a read denial for logs. Expiry is the only case with a distinct
   * client outcome; grant removal and no grant share the same response. */
  readDenied(identity) {
    if (!(Number.isFinite(identity?.expiresAt) && identity.expiresAt > this.now()))
      return credentialExpired();
    const members = this.metadata()?.acl?.members;
    return withAdmissionReason(
      new PermissionDenied(),
      members && Object.hasOwn(members, identity.principal)
        ? "page_access_removed"
        : "page_no_grant",
    );
  }

  /** The decision's own bound: the credential's expiry, or an earlier lease
   * (company view's email-domain proof) whose loss would change access. */
  leaseExpiresAt(identity) {
    this.account(identity);
    return pageDecision(this.metadata(), identity, { now: this.now() }).valid_until;
  }
}
