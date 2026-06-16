import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Globe2, Link2, Mail, Share2, Trash2, UserRound, X } from "lucide-react";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";
import { appendEndpointPathSegment, cloudResponseError } from "./cloud-response";
import {
  buildCloudMarkdownShareProjection,
  type CloudMarkdownAccessRequest,
  type CloudMarkdownDocumentAclRow,
  type CloudMarkdownDocumentInvite,
  type CloudMarkdownShareAccessRow,
  type CloudMarkdownShareInviteScope,
} from "./markdown-sharing";
import { normalizeShareInviteEmail } from "./sharing-client";

interface MarkdownSharingControlsProps {
  accessRequestsEndpoint: string;
  aclEndpoint: string;
  authState: CloudPrototypeAuthState;
  invitesEndpoint: string;
  publicLink: string;
}

type MarkdownSharingLoadState = "idle" | "loading" | "ready" | "error";
type MarkdownSharingMessageKind = "info" | "error";

export function MarkdownSharingControls({
  accessRequestsEndpoint,
  aclEndpoint,
  authState,
  invitesEndpoint,
  publicLink,
}: MarkdownSharingControlsProps) {
  const [open, setOpen] = useState(false);
  const [acl, setAcl] = useState<CloudMarkdownDocumentAclRow[]>([]);
  const [invites, setInvites] = useState<CloudMarkdownDocumentInvite[]>([]);
  const [accessRequests, setAccessRequests] = useState<CloudMarkdownAccessRequest[]>([]);
  const [loadState, setLoadState] = useState<MarkdownSharingLoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<MarkdownSharingMessageKind>("info");
  const [inviteEmail, setInviteEmail] = useState("");
  const [scope, setScope] = useState<CloudMarkdownShareInviteScope>("viewer");
  const [formError, setFormError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const accessProjection = useMemo(
    () => buildCloudMarkdownShareProjection({ acl, invites, accessRequests }),
    [accessRequests, acl, invites],
  );
  const publicEnabled = acl.some(
    (row) => row.subject_kind === "public" && row.subject === "anonymous" && row.scope === "viewer",
  );

  const ownerAuth = useMemo(
    () =>
      authState.mode === "dev" ? { ...authState, requestedScope: "owner" as const } : authState,
    [authState],
  );

  const loadSharingState = useCallback(
    async (options?: { preserveMessage?: boolean; signal?: AbortSignal }) => {
      setLoadState("loading");
      if (!options?.preserveMessage) {
        setMessage(null);
      }
      try {
        const [aclResponse, invitesResponse, accessRequestsResponse] = await Promise.all([
          fetchWithCloudPrototypeAuth(
            aclEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            ownerAuth,
          ),
          fetchWithCloudPrototypeAuth(
            invitesEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            ownerAuth,
          ),
          fetchWithCloudPrototypeAuth(
            accessRequestsEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            ownerAuth,
          ),
        ]);
        if (options?.signal?.aborted) {
          return;
        }
        if (!aclResponse.ok) {
          throw await cloudResponseError(
            aclResponse,
            aclResponse.status === 403
              ? "Only the document owner can manage sharing"
              : "Unable to load access",
          );
        }
        if (!invitesResponse.ok) {
          throw await cloudResponseError(
            invitesResponse,
            invitesResponse.status === 403
              ? "Only the document owner can manage invites"
              : "Unable to load invites",
          );
        }
        if (!accessRequestsResponse.ok) {
          throw await cloudResponseError(
            accessRequestsResponse,
            accessRequestsResponse.status === 403
              ? "Only the document owner can manage access requests"
              : "Unable to load access requests",
          );
        }
        const aclBody = (await aclResponse.json()) as { acl?: CloudMarkdownDocumentAclRow[] };
        const invitesBody = (await invitesResponse.json()) as {
          invites?: CloudMarkdownDocumentInvite[];
        };
        const accessRequestsBody = (await accessRequestsResponse.json()) as {
          access_requests?: CloudMarkdownAccessRequest[];
        };
        setAcl(Array.isArray(aclBody.acl) ? aclBody.acl : []);
        setInvites(Array.isArray(invitesBody.invites) ? invitesBody.invites : []);
        setAccessRequests(
          Array.isArray(accessRequestsBody.access_requests)
            ? accessRequestsBody.access_requests
            : [],
        );
        setLoadState("ready");
      } catch (error) {
        if (options?.signal?.aborted) {
          return;
        }
        setLoadState("error");
        setMessageKind("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [accessRequestsEndpoint, aclEndpoint, invitesEndpoint, ownerAuth],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadSharingState({ signal: controller.signal });
    return () => controller.abort();
  }, [loadSharingState, open]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicLink);
      setMessageKind("info");
      setMessage("Link copied.");
    } catch {
      setMessageKind("error");
      setMessage("Unable to copy the link.");
    }
  };

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitLockRef.current) {
      return;
    }
    const email = normalizeShareInviteEmail(inviteEmail);
    if (!email) {
      setFormError("Enter a valid email address.");
      return;
    }

    submitLockRef.current = true;
    setBusyAction("grant");
    setFormError(null);
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        invitesEndpoint,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email, scope }),
        },
        ownerAuth,
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to create invite");
      }
      setInviteEmail("");
      setMessageKind("info");
      setMessage(`Invite created for ${email}.`);
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      submitLockRef.current = false;
      setBusyAction(null);
    }
  };

  const togglePublicAccess = async () => {
    setBusyAction("public");
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        aclEndpoint,
        {
          method: publicEnabled ? "DELETE" : "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject_kind: "public",
            subject: "anonymous",
            scope: "viewer",
          }),
        },
        ownerAuth,
      );
      if (!response.ok) {
        throw await cloudResponseError(
          response,
          publicEnabled ? "Unable to disable public link" : "Unable to enable public link",
        );
      }
      setMessageKind("info");
      setMessage(publicEnabled ? "Public link disabled." : "Public link enabled.");
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const removeAccessRow = async (row: CloudMarkdownShareAccessRow) => {
    if (!row.removable) return;

    setBusyAction(row.id);
    setMessage(null);
    try {
      const response =
        row.kind === "invite"
          ? await fetchWithCloudPrototypeAuth(
              appendEndpointPathSegment(invitesEndpoint, row.invite.id),
              {
                method: "DELETE",
                headers: { Accept: "application/json" },
              },
              ownerAuth,
            )
          : await fetchWithCloudPrototypeAuth(
              aclEndpoint,
              {
                method: "DELETE",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  subject_kind: row.acl.subject_kind,
                  subject: row.acl.subject,
                  scope: row.acl.scope,
                }),
              },
              ownerAuth,
            );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to remove access");
      }
      setMessageKind("info");
      setMessage(`${row.label} removed.`);
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const resolveAccessRequest = async (
    row: Extract<CloudMarkdownShareAccessRow, { kind: "access_request" }>,
    action: "approve" | "deny" | "dismiss",
  ) => {
    setBusyAction(`${row.id}:${action}`);
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        appendEndpointPathSegment(accessRequestsEndpoint, row.accessRequest.id),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action }),
        },
        ownerAuth,
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to update access request");
      }
      setMessageKind("info");
      setMessage(accessRequestActionMessage(row.label, action));
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <details
      className="cloud-share-menu cloud-markdown-share-menu"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title="Share Markdown document">
        <Share2 aria-hidden="true" />
        <span>Share</span>
      </summary>
      <div className="cloud-share-panel">
        <header>
          <div>
            <h2>Share document</h2>
            <p>Invite people and manage document access.</p>
          </div>
          <button type="button" aria-label="Copy document link" onClick={() => void copyLink()}>
            <Link2 aria-hidden="true" />
            <span className="cloud-share-copy-label-full">Copy link</span>
            <span className="cloud-share-copy-label-compact">Copy</span>
          </button>
        </header>

        <section className="cloud-share-public" aria-label="Public link access">
          <div>
            <Globe2 aria-hidden="true" />
            <div>
              <strong>Anyone with the link</strong>
              <span>
                {publicEnabled
                  ? "Can view this document without signing in"
                  : "Link access is off. Only listed people can open this document"}
              </span>
            </div>
          </div>
          <button
            type="button"
            disabled={busyAction === "public" || loadState === "loading"}
            onClick={() => void togglePublicAccess()}
          >
            {publicEnabled ? "Disable" : "Enable"}
          </button>
        </section>

        <form className="cloud-share-invite" onSubmit={submitInvite}>
          <label htmlFor="cloud-markdown-share-email">
            <span>Share by email</span>
            <input
              id="cloud-markdown-share-email"
              name="share-email"
              type="email"
              value={inviteEmail}
              placeholder="name@example.com"
              autoComplete="email"
              onChange={(event) => {
                setInviteEmail(event.target.value);
                setFormError(null);
              }}
            />
          </label>
          <label htmlFor="cloud-markdown-share-scope">
            <span>Access</span>
            <select
              id="cloud-markdown-share-scope"
              name="share-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as CloudMarkdownShareInviteScope)}
            >
              <option value="viewer">Can view</option>
              <option value="editor">Can edit</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={normalizeShareInviteEmail(inviteEmail) === null || busyAction === "grant"}
          >
            <Mail aria-hidden="true" />
            Share
          </button>
          {formError ? (
            <div className="cloud-auth-form-error" role="alert">
              {formError}
            </div>
          ) : null}
        </form>

        <section className="cloud-share-current" aria-label="Current document access">
          <div className="cloud-share-current-heading">
            <h3>Current access</h3>
            {accessProjection.summary ? <span>{accessProjection.summary}</span> : null}
          </div>
          {loadState === "loading" && accessProjection.rows.length === 0 ? (
            <div className="cloud-share-empty">Loading access...</div>
          ) : accessProjection.rows.length === 0 ? (
            <div className="cloud-share-empty">Only the owner can access this document.</div>
          ) : (
            <ul>
              {accessProjection.rows.map((row) => (
                <li key={row.id} title={row.title}>
                  <UserRound aria-hidden="true" />
                  <div>
                    <strong>{row.label}</strong>
                    <span>{row.detail}</span>
                  </div>
                  <div className="cloud-share-row-actions">
                    <span className="cloud-share-badge">{row.badge}</span>
                    {row.stateLabel ? (
                      <span className="cloud-share-state" data-tone="pending">
                        {row.stateLabel}
                      </span>
                    ) : null}
                    {row.kind === "access_request" ? (
                      <>
                        <button
                          type="button"
                          aria-label={`Approve ${row.label}`}
                          title={`Approve ${row.label}`}
                          disabled={busyAction === `${row.id}:approve`}
                          onClick={() => void resolveAccessRequest(row, "approve")}
                        >
                          <Check aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Deny ${row.label}`}
                          title={`Deny ${row.label}`}
                          disabled={busyAction === `${row.id}:deny`}
                          onClick={() => void resolveAccessRequest(row, "deny")}
                        >
                          <X aria-hidden="true" />
                        </button>
                      </>
                    ) : null}
                    {row.removable ? (
                      <button
                        type="button"
                        aria-label={`Remove ${row.label}`}
                        title={`Remove ${row.label}`}
                        disabled={busyAction === row.id}
                        onClick={() => void removeAccessRow(row)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {message ? (
          <div className="cloud-share-message" data-kind={messageKind}>
            {message}
          </div>
        ) : null}
        {loadState === "error" && !message ? (
          <div className="cloud-share-message" data-kind="error">
            Unable to load document sharing.
          </div>
        ) : null}
      </div>
    </details>
  );
}

function accessRequestActionMessage(label: string, action: "approve" | "deny" | "dismiss"): string {
  switch (action) {
    case "approve":
      return `${label} can now edit.`;
    case "deny":
      return `${label}'s request was denied.`;
    case "dismiss":
      return `${label}'s request was dismissed.`;
  }
}
