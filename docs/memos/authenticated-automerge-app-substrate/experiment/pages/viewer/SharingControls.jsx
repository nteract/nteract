import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Copy, Share2 } from "lucide-react";
import { SharingPanel } from "../../../../../../src/components/sharing/SharingPanel.tsx";
import "./sharing-panel.css";
import { createSharingAccess, sharingAvailable, SHARING_FRESH_MS } from "./sharing-access.mjs";
import { domainSharingProjection } from "./sharing-projection.mjs";
import { pageMarkdown } from "../model/markdown-export.mjs";

function projection(value, manage) {
  const rows = [];
  const row = (value) => ({
    detail: "",
    title: value.label,
    stateLabel: null,
    stateTone: null,
    ...value,
  });
  if (value?.owner)
    rows.push(
      row({
        id: "owner",
        kind: "acl",
        label: value.owner.displayName || "Owner",
        badge: "Owner",
        removable: false,
      }),
    );
  for (const member of value?.members ?? [])
    rows.push(
      row({
        id: member.principal,
        kind: "acl",
        principal: member.principal,
        label: member.displayName || member.email || "Collaborator",
        detail: member.email || "",
        badge: member.role === "editor" ? "Can edit" : "Can view",
        removable: manage,
      }),
    );
  for (const invite of value?.invites ?? [])
    rows.push(
      row({
        id: invite.id,
        kind: "invite",
        label: invite.email,
        badge: invite.role === "editor" ? "Can edit" : "Can view",
        stateLabel: "Pending",
        stateTone: "pending",
        removable: manage,
      }),
    );
  return {
    accessRows: rows,
    accessSummary: null,
    accessRequestRows: [],
    accessRequestSummary: null,
    runtimeAccessRows: [],
    runtimeAccessSummary: null,
  };
}
/**
 * Share for one Page. By default it renders its own Share button and owns its
 * open state. With `trigger={false}` another control opens it: the caller owns
 * `open` and `onOpenChange`, the panel takes focus when it opens, and Escape
 * returns focus to `returnFocus`.
 */
export function SharingControls({ session, ...options }) {
  return (
    <PageSharing
      key={`${session.identity?.principal}:${session.pageId}`}
      session={session}
      {...options}
    />
  );
}
function PageSharing({ session, trigger = true, open: requested, onOpenChange, returnFocus }) {
  const [own, setOwn] = useState(false),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("viewer"),
    [copyError, setCopyError] = useState(""),
    [message, setMessage] = useState(""),
    [copyMessage, setCopyMessage] = useState("");
  const cache = useMemo(() => createSharingAccess(session), [session]);
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const available = sharingAvailable(session);
  const value =
      available && (!state.value?.access.canManageAccess || session.canManageAccess)
        ? state.value
        : null,
    busy = state.busy,
    error = state.error?.message || copyError,
    loading = available && !value && !state.error;
  const domainId = useId();
  const controlled = requested !== undefined;
  const open = controlled ? requested : own;
  const changeOpen = useRef(null);
  changeOpen.current = controlled ? (value) => onOpenChange?.(value) : setOwn;
  const root = useRef(null),
    button = useRef(null),
    dialog = useRef(null),
    epoch = useRef(0),
    proofExpired = useRef(false);
  useEffect(() => {
    cache.activate();
    return () => cache.dispose();
  }, [cache]);
  // Start before Share is opened. Re-check when session authority changes, but
  // not on ordinary document edits or popover close/reopen.
  useEffect(() => {
    cache.invalidate();
    if (available) void cache.read().catch(() => {});
  }, [
    cache,
    available,
    session.canManageAccess,
    session.access?.revision,
    session.access?.generation,
  ]);
  useEffect(() => {
    if (!open) return;
    ++epoch.current;
    setCopyError("");
    setMessage("");
    setCopyMessage("");
    // While company proof is expired, returning from the sign-in tab must
    // bypass the freshness window to pick up the renewed proof.
    const refresh = () => {
      if (document.visibilityState !== "hidden")
        void cache.read({ force: proofExpired.current }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, SHARING_FRESH_MS);
    const outside = (event) => {
      if (!root.current?.contains(event.target)) changeOpen.current(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        changeOpen.current(false);
        (trigger ? button : returnFocus)?.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      epoch.current++;
      clearInterval(timer);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, cache, trigger, returnFocus]);
  // Opened from another control, the panel takes focus so its contents come next.
  useEffect(() => {
    if (open && !trigger) dialog.current?.focus({ preventScroll: true });
  }, [open, trigger]);
  async function mutate(action, key) {
    if (busy || !manage) return;
    const revision = epoch.current;
    setCopyError("");
    setMessage("");
    try {
      const result = await cache.mutate(action, key);
      if (!result || revision !== epoch.current) return;
      if (key === "invite") {
        setEmail("");
        setMessage("Access updated. Copy the link to share it.");
      }
    } catch {
      // The resource retains the error and invalidates/reloads stale access.
    }
  }
  async function copyMarkdown() {
    const revision = epoch.current;
    setCopyMessage("");
    try {
      if (!session.access?.canRead || session.accessDenied) throw Error("Page access changed");
      await navigator.clipboard.writeText(pageMarkdown(session.snapshot()));
      if (revision === epoch.current) setCopyMessage("Markdown copied.");
    } catch {
      if (revision === epoch.current) setCopyMessage("Could not copy the Markdown. Try again.");
    }
  }
  async function copyLink() {
    const revision = epoch.current;
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname);
      if (revision === epoch.current) setMessage("Link copied.");
    } catch {
      if (revision === epoch.current) setCopyError("Could not copy the link.");
    }
  }
  const manage = available && !!session.canManageAccess && !!value?.access.canManageAccess;
  const showInvite =
    manage ||
    (!value &&
      available &&
      !!session.canManageAccess &&
      session.access?.role === "owner" &&
      ![401, 403, 404].includes(state.error?.status));
  const domainSharing = manage ? domainSharingProjection(value) : null;
  proofExpired.current = !!domainSharing?.expired;
  return (
    <div className="page-sharing" ref={root}>
      {trigger && (
        <button
          ref={button}
          className="subtle-button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => changeOpen.current(!open)}
        >
          <Share2 size={17} aria-hidden="true" />
          <span>Share</span>
        </button>
      )}
      {open && (
        <div
          ref={dialog}
          className="page-sharing-popover"
          role="dialog"
          aria-label="Share Page"
          tabIndex={trigger ? undefined : -1}
        >
          <SharingPanel
            resourceLabel="Page"
            title="Share Page"
            description={
              showInvite
                ? "Invite by email, then share the link."
                : session.access?.role === "viewer"
                  ? "You can view this Page. Only the owner can invite people."
                  : "Only the owner can invite people."
            }
            sections={{
              publicAccess: false,
              invites: showInvite,
              accessRequests: false,
              runtimeAccess: false,
            }}
            emptyAccessMessage={
              manage ? "Only you have access." : "Access is managed by the Page owner."
            }
            accessProjection={projection(value, manage)}
            busyAction={busy}
            copyLinkLabel="Copy link"
            compactCopyLinkLabel="Copy link"
            onCopyLink={copyLink}
            formError={error || null}
            message={showInvite ? message || null : error || message || null}
            messageKind={error ? "error" : "info"}
            inviteEmail={email}
            onInviteEmailChange={setEmail}
            inviteScope={role}
            onInviteScopeChange={setRole}
            inviteReady={!busy && !!email.trim() && manage}
            onSubmitInvite={(event) => {
              event.preventDefault();
              void mutate({ action: "invite", email, role }, "invite");
            }}
            onRemoveAccessRow={(row) =>
              void mutate(
                row.kind === "invite"
                  ? { action: "revoke_invite", invite_id: row.id }
                  : { action: "set_role", principal: row.principal, role: null },
                row.id,
              )
            }
            onResolveAccessRequest={() => {}}
            onTogglePublicAccess={() => {}}
            publicBusy={false}
            publicEnabled={false}
            showInitialAccessLoading={loading}
          />
          {state.error && available && (
            <button
              className="subtle-button"
              disabled={state.refreshing || !!busy}
              onClick={() => void cache.read({ force: true }).catch(() => {})}
            >
              Retry sharing settings
            </button>
          )}
          {domainSharing && (
            <section className="page-domain-sharing" aria-labelledby={domainId}>
              <label id={domainId} htmlFor={`${domainId}-select`}>
                Link access
              </label>
              <select
                id={`${domainId}-select`}
                value={domainSharing.selected}
                disabled={!!busy}
                onChange={(event) =>
                  void mutate(
                    { action: "set_domain_view", domain: event.target.value || null },
                    "domain-view",
                  )
                }
              >
                {domainSharing.options.map(({ value, label, disabled }) => (
                  <option key={value} value={value} disabled={disabled}>
                    {label}
                  </option>
                ))}
              </select>
              <p>
                {domainSharing.selected ? (
                  <>
                    <strong>Can view.</strong> Sign in with a verified {domainSharing.selected}{" "}
                    email.
                  </>
                ) : (
                  "Only you and invited people can open this Page."
                )}
              </p>
              {domainSharing.expired ? (
                <div className="page-domain-sharing-note" role="note">
                  <p>
                    Your company email verification expired. Sign in again with the same account to
                    enable company sharing.
                  </p>
                  {domainSharing.unverified && (
                    <p>
                      People at {domainSharing.selected} can still view this Page. Choose Restricted
                      to stop sharing with them.
                    </p>
                  )}
                  <div className="page-domain-sharing-actions">
                    {/* The same sign-in the session uses; a separate tab keeps
                        this Page open and its edits running. */}
                    <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
                      Sign in again
                    </a>
                    <button
                      type="button"
                      className="subtle-button"
                      disabled={state.refreshing || !!busy}
                      onClick={() => void cache.read({ force: true }).catch(() => {})}
                    >
                      Refresh sharing settings
                    </button>
                  </div>
                </div>
              ) : (
                domainSharing.unverified && (
                  <p className="page-domain-sharing-note" role="note">
                    You are not signed in with a verified {domainSharing.selected} email. People at{" "}
                    {domainSharing.selected} can still view this Page. Choose Restricted to stop
                    sharing with them; sharing again needs a verified {domainSharing.selected}{" "}
                    email.
                  </p>
                )
              )}
            </section>
          )}
          <div className="page-sharing-export">
            <button
              type="button"
              className="subtle-button"
              disabled={!session.access?.canRead || session.accessDenied}
              onClick={copyMarkdown}
            >
              <Copy size={16} aria-hidden="true" /> Copy as Markdown
            </button>
            <p className="copy-status" role="status" aria-live="polite" aria-atomic="true">
              {copyMessage}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
