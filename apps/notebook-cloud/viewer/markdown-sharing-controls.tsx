import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link2, Share2, Trash2, UserRound } from "lucide-react";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";
import { cloudResponseError } from "./cloud-response";
import {
  buildCloudMarkdownShareProjection,
  type CloudMarkdownDocumentAclRow,
  type CloudMarkdownShareScope,
} from "./markdown-sharing";

interface MarkdownSharingControlsProps {
  aclEndpoint: string;
  authState: CloudPrototypeAuthState;
  publicLink: string;
}

type MarkdownSharingLoadState = "idle" | "loading" | "ready" | "error";
type MarkdownSharingMessageKind = "info" | "error";

export function MarkdownSharingControls({
  aclEndpoint,
  authState,
  publicLink,
}: MarkdownSharingControlsProps) {
  const [open, setOpen] = useState(false);
  const [acl, setAcl] = useState<CloudMarkdownDocumentAclRow[]>([]);
  const [loadState, setLoadState] = useState<MarkdownSharingLoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<MarkdownSharingMessageKind>("info");
  const [principal, setPrincipal] = useState("");
  const [scope, setScope] = useState<Exclude<CloudMarkdownShareScope, "owner">>("viewer");
  const [formError, setFormError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const accessProjection = useMemo(() => buildCloudMarkdownShareProjection({ acl }), [acl]);

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
        const response = await fetchWithCloudPrototypeAuth(
          aclEndpoint,
          { headers: { Accept: "application/json" }, signal: options?.signal },
          ownerAuth,
        );
        if (options?.signal?.aborted) {
          return;
        }
        if (!response.ok) {
          throw await cloudResponseError(
            response,
            response.status === 403
              ? "Only the document owner can manage sharing"
              : "Unable to load access",
          );
        }
        const body = (await response.json()) as { acl?: CloudMarkdownDocumentAclRow[] };
        setAcl(Array.isArray(body.acl) ? body.acl : []);
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
    [aclEndpoint, ownerAuth],
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

  const submitAccess = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitLockRef.current) {
      return;
    }
    const subject = principal.trim();
    if (!subject) {
      setFormError("Enter a principal.");
      return;
    }

    submitLockRef.current = true;
    setBusyAction("grant");
    setFormError(null);
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        aclEndpoint,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject_kind: "principal",
            subject,
            scope,
          }),
        },
        ownerAuth,
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to grant document access");
      }
      setPrincipal("");
      setMessageKind("info");
      setMessage(`Access granted to ${subject}.`);
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      submitLockRef.current = false;
      setBusyAction(null);
    }
  };

  const removeAccessRow = async (row: CloudMarkdownDocumentAclRow) => {
    setBusyAction(`remove:${row.subject_kind}:${row.subject}:${row.scope}`);
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        aclEndpoint,
        {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject_kind: row.subject_kind,
            subject: row.subject,
            scope: row.scope,
          }),
        },
        ownerAuth,
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to remove document access");
      }
      setMessageKind("info");
      setMessage("Access removed.");
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
            <p>Grant document access to another nteract principal.</p>
          </div>
          <button type="button" aria-label="Copy document link" onClick={() => void copyLink()}>
            <Link2 aria-hidden="true" />
            <span className="cloud-share-copy-label-full">Copy link</span>
            <span className="cloud-share-copy-label-compact">Copy</span>
          </button>
        </header>

        <form className="cloud-share-invite" onSubmit={submitAccess}>
          <label htmlFor="cloud-markdown-share-principal">
            <span>Principal</span>
            <input
              id="cloud-markdown-share-principal"
              name="share-principal"
              type="text"
              value={principal}
              placeholder="user:anaconda:..."
              autoComplete="off"
              onChange={(event) => {
                setPrincipal(event.target.value);
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
              onChange={(event) =>
                setScope(event.target.value as Exclude<CloudMarkdownShareScope, "owner">)
              }
            >
              <option value="viewer">Can view</option>
              <option value="editor">Can edit</option>
            </select>
          </label>
          <button type="submit" disabled={!principal.trim() || busyAction === "grant"}>
            <UserRound aria-hidden="true" />
            Grant
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
                    {row.removable ? (
                      <button
                        type="button"
                        aria-label={`Remove ${row.label}`}
                        title={`Remove ${row.label}`}
                        disabled={
                          busyAction ===
                          `remove:${row.acl.subject_kind}:${row.acl.subject}:${row.acl.scope}`
                        }
                        onClick={() => void removeAccessRow(row.acl)}
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
