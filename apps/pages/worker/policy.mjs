import { pageAccess, pageDecision, pageGrant } from "./access.mjs";
import { withAdmissionReason } from "./admission-reasons.mjs";

export class PermissionDenied extends Error {
  constructor(message = "Document access denied", code = "page_access_denied") {
    super(message);
    this.status = 403;
    this.code = code;
  }
}

/** An inherited lease requires a fresh policy resolution, not a new credential.
 * A company-domain or organization lease that ends is the credential's own
 * evidence ending: authenticating again reads it afresh. */
export function leaseExpiryError(identity, deadline) {
  const evidence = [identity.domainAccess, ...(identity.organizations ?? [])];
  return deadline < identity.expiresAt && !evidence.some((lease) => lease?.expiresAt === deadline)
    ? withAdmissionReason(
        Object.assign(new Error("Project authority lease expired"), {
          status: 503,
          code: "project_policy_unavailable",
        }),
        "project_lease_expired",
      )
    : credentialExpired();
}

/** A Page's Project could not be read, so whether its members reach the Page
 * is unknown. The caller should try again; it is not refused. */
export function projectPolicyUnavailable() {
  return withAdmissionReason(
    Object.assign(new Error("Project access cannot be verified; try again"), {
      status: 503,
      code: "project_policy_unavailable",
    }),
    "project_unavailable",
  );
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
 * `metadata(identity)` is the record as the host currently enforces it for
 * that caller.
 * `projectUnavailable(identity)` is true when the host could not read the
 * Page's Project for that caller: a refusal then says to try again. */
export class DocumentPolicy {
  constructor({ metadata, now = Date.now, projectUnavailable = () => false }) {
    this.metadata = metadata;
    this.now = now;
    this.projectUnavailable = projectUnavailable;
  }

  /** `write` is false to read, true to edit the Page, or "comment" to write
   * its comments document. */
  account(identity, write = false) {
    const access = pageAccess(this.metadata(identity), identity, { now: this.now() });
    if (access.trashed && (!access.canRead || write))
      throw pageTrashed(access, pageGrant(this.metadata(identity), identity?.principal));
    if (!access.canRead) throw this.readDenied(identity);
    const comment = write === "comment";
    if (write && !comment && this.metadata(identity)?.recoveryBlocked)
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

  /** Classify a read denial for logs. Expiry and an unreadable Project have
   * distinct client outcomes; grant removal and no grant share the same
   * response. */
  readDenied(identity) {
    if (!(Number.isFinite(identity?.expiresAt) && identity.expiresAt > this.now()))
      return credentialExpired();
    if (this.projectUnavailable(identity)) return projectPolicyUnavailable();
    const members = this.metadata(identity)?.acl?.members;
    return withAdmissionReason(
      new PermissionDenied(),
      members && Object.hasOwn(members, identity.principal)
        ? "page_access_removed"
        : "page_no_grant",
    );
  }

  /** The decision's own bound: the credential's expiry, or an earlier lease
   * (company view's email-domain proof, or an organization's membership
   * evidence) whose loss would change access. */
  leaseExpiresAt(identity) {
    this.account(identity);
    return pageDecision(this.metadata(identity), identity, { now: this.now() }).valid_until;
  }
}
