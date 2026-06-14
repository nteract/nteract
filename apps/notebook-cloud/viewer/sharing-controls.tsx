import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Globe2, Link2, Mail, ServerCog, Share2, Trash2, UserRound, X } from "lucide-react";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";
import { appendEndpointPathSegment, cloudResponseError } from "./cloud-response";
import {
  projectCloudSharingFacts,
  type CloudSharingCopyState,
  type CloudSharingLoadState,
} from "./cloud-sharing-facts";
import {
  normalizeShareInviteEmail,
  type CloudNotebookAccessRequest,
  type CloudNotebookAclRow,
  type CloudNotebookInvite,
  type CloudShareAccessRow,
  type CloudShareInviteScope,
} from "./sharing-client";

interface CloudSharingControlsProps {
  accessRequestsEndpoint: string;
  aclEndpoint: string;
  authState: CloudPrototypeAuthState;
  invitesEndpoint: string;
  publicLink: string;
}

type CloudSharingMessageKind = "info" | "error";
type CloudSharingAccessRequestAction = "approve" | "deny" | "dismiss";

export function CloudSharingControls({
  accessRequestsEndpoint,
  aclEndpoint,
  authState,
  invitesEndpoint,
  publicLink,
}: CloudSharingControlsProps) {
  const [open, setOpen] = useState(false);
  const [acl, setAcl] = useState<CloudNotebookAclRow[]>([]);
  const [invites, setInvites] = useState<CloudNotebookInvite[]>([]);
  const [accessRequests, setAccessRequests] = useState<CloudNotebookAccessRequest[]>([]);
  const [loadState, setLoadState] = useState<CloudSharingLoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<CloudSharingMessageKind>("info");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteScope, setInviteScope] = useState<CloudShareInviteScope>("viewer");
  const [formError, setFormError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CloudSharingCopyState>("idle");
  const inviteSubmitLockRef = useRef(false);
  const sharingFacts = useMemo(
    () =>
      projectCloudSharingFacts({
        accessRequests,
        acl,
        copyState,
        inviteEmail,
        invites,
        loadState,
      }),
    [accessRequests, acl, copyState, inviteEmail, invites, loadState],
  );
  const accessProjection = sharingFacts.access;
  const publicEnabled = sharingFacts.publicEnabled;
  const inviteReady = sharingFacts.inviteReady;

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
            authState,
          ),
          fetchWithCloudPrototypeAuth(
            invitesEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            authState,
          ),
          fetchWithCloudPrototypeAuth(
            accessRequestsEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            authState,
          ),
        ]);
        if (options?.signal?.aborted) {
          return;
        }
        if (!aclResponse.ok) {
          throw await cloudResponseError(
            aclResponse,
            aclResponse.status === 403
              ? "Only the notebook owner can manage sharing"
              : "Unable to load access list",
          );
        }
        if (!invitesResponse.ok) {
          throw await cloudResponseError(
            invitesResponse,
            invitesResponse.status === 403
              ? "Only the notebook owner can manage invites"
              : "Unable to load invites",
          );
        }
        if (!accessRequestsResponse.ok) {
          throw await cloudResponseError(
            accessRequestsResponse,
            accessRequestsResponse.status === 403
              ? "Only the notebook owner can manage access requests"
              : "Unable to load access requests",
          );
        }
        const aclBody = (await aclResponse.json()) as { acl?: CloudNotebookAclRow[] };
        const invitesBody = (await invitesResponse.json()) as { invites?: CloudNotebookInvite[] };
        const accessRequestsBody = (await accessRequestsResponse.json()) as {
          access_requests?: CloudNotebookAccessRequest[];
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
    [accessRequestsEndpoint, aclEndpoint, authState, invitesEndpoint],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadSharingState({ signal: controller.signal });
    return () => controller.abort();
  }, [loadSharingState, open]);

  const copyPublicLink = async () => {
    try {
      await navigator.clipboard.writeText(publicLink);
      setCopyState("copied");
      setMessageKind("info");
      setMessage("Link copied.");
    } catch {
      setCopyState("failed");
      setMessageKind("error");
      setMessage("Unable to copy the link.");
    }
  };

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inviteSubmitLockRef.current) {
      return;
    }
    const email = normalizeShareInviteEmail(inviteEmail);
    if (!email) {
      setFormError("Enter a valid email address.");
      return;
    }

    inviteSubmitLockRef.current = true;
    setBusyAction("invite");
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
          body: JSON.stringify({ email, scope: inviteScope }),
        },
        authState,
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
      inviteSubmitLockRef.current = false;
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
        authState,
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

  const removeAccessRow = async (row: CloudShareAccessRow) => {
    if (!row.removable) return;
    if (row.kind === "access_request") return;

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
              authState,
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
              authState,
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
    row: Extract<CloudShareAccessRow, { kind: "access_request" }>,
    action: CloudSharingAccessRequestAction,
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
        authState,
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
      className="cloud-share-menu"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title="Share notebook">
        <Share2 aria-hidden="true" />
        <span>Share</span>
      </summary>
      <div className="cloud-share-panel">
        <header>
          <div>
            <h2>Share notebook</h2>
            <p>Invite people, review requests, and manage link access.</p>
          </div>
          <button
            type="button"
            aria-label={sharingFacts.copyLinkLabel}
            onClick={() => void copyPublicLink()}
          >
            <Link2 aria-hidden="true" />
            <span className="cloud-share-copy-label-full">{sharingFacts.copyLinkLabel}</span>
            <span className="cloud-share-copy-label-compact">
              {sharingFacts.compactCopyLinkLabel}
            </span>
          </button>
        </header>

        <section className="cloud-share-public" aria-label="Public link access">
          <div>
            <Globe2 aria-hidden="true" />
            <div>
              <strong>Anyone with the link</strong>
              <span>
                {publicEnabled
                  ? "Can view this notebook without signing in"
                  : "Link access is off. Only listed people can open this notebook"}
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
          <label htmlFor="cloud-share-invite-email">
            <span>Invite by email</span>
            <input
              id="cloud-share-invite-email"
              name="invite-email"
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
          <label htmlFor="cloud-share-invite-scope">
            <span>Access</span>
            <select
              id="cloud-share-invite-scope"
              name="invite-scope"
              value={inviteScope}
              onChange={(event) => setInviteScope(event.target.value as CloudShareInviteScope)}
            >
              <option value="viewer">Can view</option>
              <option value="editor">Can edit</option>
            </select>
          </label>
          <button type="submit" disabled={!inviteReady || busyAction === "invite"}>
            <Mail aria-hidden="true" />
            Invite
          </button>
          {formError ? (
            <div className="cloud-auth-form-error" role="alert">
              {formError}
            </div>
          ) : null}
        </form>

        {accessProjection.accessRequestRows.length > 0 ? (
          <section
            className="cloud-share-current cloud-share-requests"
            aria-label="Edit access requests"
          >
            <div className="cloud-share-current-heading">
              <div>
                <h3>Edit requests</h3>
                <p>Approve collaborators you recognize, or dismiss stale requests.</p>
              </div>
              {accessProjection.accessRequestSummary ? (
                <span>{accessProjection.accessRequestSummary}</span>
              ) : null}
            </div>
            <ul>
              {accessProjection.accessRequestRows.map((row) => (
                <li key={row.id} title={row.title}>
                  <CloudShareRowIcon row={row} />
                  <div>
                    <strong>{row.label}</strong>
                    <span>{row.detail}</span>
                  </div>
                  <div className="cloud-share-row-actions">
                    <span className="cloud-share-badge">{row.badge}</span>
                    <span className="cloud-share-state" data-tone={row.stateTone ?? undefined}>
                      {row.stateLabel}
                    </span>
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
                    <button
                      type="button"
                      aria-label={`Dismiss ${row.label}`}
                      title={`Dismiss ${row.label}`}
                      disabled={busyAction === `${row.id}:dismiss`}
                      onClick={() => void resolveAccessRequest(row, "dismiss")}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="cloud-share-current" aria-label="Current notebook access">
          <div className="cloud-share-current-heading">
            <h3>Current access</h3>
            {accessProjection.notebookAccessSummary ? (
              <span>{accessProjection.notebookAccessSummary}</span>
            ) : null}
          </div>
          {sharingFacts.showInitialAccessLoading ? (
            <div className="cloud-share-empty">Loading access...</div>
          ) : accessProjection.notebookAccessRows.length === 0 ? (
            <div className="cloud-share-empty">Only the owner can access this notebook.</div>
          ) : (
            <ul>
              {accessProjection.notebookAccessRows.map((row) => (
                <li key={row.id} title={row.title}>
                  <CloudShareRowIcon row={row} />
                  <div>
                    <strong>{row.label}</strong>
                    <span>{row.detail}</span>
                  </div>
                  <div className="cloud-share-row-actions">
                    <span className="cloud-share-badge">{row.badge}</span>
                    {row.stateLabel ? (
                      <span className="cloud-share-state" data-tone={row.stateTone ?? undefined}>
                        {row.stateLabel}
                      </span>
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

        {accessProjection.runtimeAccessRows.length > 0 ? (
          <section className="cloud-share-current cloud-share-runtime" aria-label="Compute access">
            <div className="cloud-share-current-heading">
              <h3>Compute access</h3>
              {accessProjection.runtimeAccessSummary ? (
                <span>{accessProjection.runtimeAccessSummary}</span>
              ) : null}
            </div>
            <ul>
              {accessProjection.runtimeAccessRows.map((row) => (
                <li key={row.id} title={row.title}>
                  <CloudShareRowIcon row={row} />
                  <div>
                    <strong>{row.label}</strong>
                    <span>{row.detail}</span>
                  </div>
                  <div className="cloud-share-row-actions">
                    <span className="cloud-share-badge">{row.badge}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {message ? (
          <div className="cloud-share-message" data-kind={messageKind}>
            {message}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function CloudShareRowIcon({ row }: { row: CloudShareAccessRow }) {
  if (row.kind === "invite") {
    return <Mail aria-hidden="true" />;
  }
  if (row.kind === "access_request") {
    return <UserRound aria-hidden="true" />;
  }
  if (row.kind === "acl" && row.scope === "runtime_peer") {
    return <ServerCog aria-hidden="true" />;
  }
  if (row.acl.subject_kind === "public") {
    return <Globe2 aria-hidden="true" />;
  }
  return <UserRound aria-hidden="true" />;
}

function accessRequestActionMessage(
  label: string,
  action: CloudSharingAccessRequestAction,
): string {
  switch (action) {
    case "approve":
      return `${label} can now edit.`;
    case "deny":
      return `${label} denied.`;
    case "dismiss":
      return `${label} dismissed.`;
  }
}
