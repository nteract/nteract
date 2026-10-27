import React, { useEffect, useId, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { SharingPanel } from "../../../../../../src/components/sharing/SharingPanel.tsx";
import "../../../../../../src/components/sharing/sharing-panel.css";
import { request } from "./session.mjs";
import { domainSharingProjection } from "./sharing-projection.mjs";

function projection(value) {
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
        removable: true,
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
        removable: true,
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
export function SharingControls({ session }) {
  const [open, setOpen] = useState(false),
    [value, setValue] = useState(null),
    [loading, setLoading] = useState(false),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("viewer"),
    [busy, setBusy] = useState(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const domainId = useId();
  const root = useRef(null),
    button = useRef(null),
    epoch = useRef(0);
  const endpoint = `/api/access?page=${encodeURIComponent(session.pageId)}`;
  useEffect(() => {
    if (!open) return;
    const revision = ++epoch.current;
    setLoading(true);
    setValue(null);
    setError("");
    setMessage("");
    request(endpoint)
      .then((result) => {
        if (epoch.current === revision) setValue(result);
      })
      .catch((error) => {
        if (epoch.current === revision) setError(error.message);
      })
      .finally(() => {
        if (epoch.current === revision) setLoading(false);
      });
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      epoch.current++;
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, endpoint]);
  async function mutate(action, key) {
    if (busy || !value?.access.canManageAccess) return;
    const revision = epoch.current;
    setBusy(key);
    setError("");
    setMessage("");
    try {
      const result = await request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...action,
          expected_revision: value.access.revision,
          idempotency_key: crypto.randomUUID(),
        }),
      });
      if (revision !== epoch.current) return;
      setValue(result);
      if (key === "invite") {
        setEmail("");
        setMessage("Access updated. Copy the link to share it.");
      }
    } catch (error) {
      if (revision !== epoch.current) return;
      setError(error.message);
      if (error.status === 409)
        try {
          const result = await request(endpoint);
          if (revision === epoch.current) setValue(result);
        } catch {}
    } finally {
      if (revision === epoch.current) setBusy(null);
    }
  }
  const manage = !loading && !!session.canManageAccess && !!value?.access.canManageAccess;
  const domainSharing = manage ? domainSharingProjection(value) : null;
  return (
    <div className="page-sharing" ref={root}>
      <button
        ref={button}
        className="subtle-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setBusy(null);
          if (!open) {
            setValue(null);
            setLoading(true);
          }
          setOpen(!open);
        }}
      >
        <Share2 size={17} aria-hidden="true" />
        <span>Share</span>
      </button>
      {open && (
        <div className="page-sharing-popover" role="dialog" aria-label="Share Page">
          <SharingPanel
            resourceLabel="Page"
            title="Share Page"
            description={
              manage
                ? "Invite by email, then share the link."
                : session.access?.role === "viewer"
                  ? "You can view this Page. Only the owner can invite people."
                  : "Only the owner can invite people."
            }
            sections={{
              publicAccess: false,
              invites: manage,
              accessRequests: false,
              runtimeAccess: false,
            }}
            emptyAccessMessage={
              manage ? "Only you have access." : "Access is managed by the Page owner."
            }
            accessProjection={projection(value)}
            busyAction={busy}
            copyLinkLabel="Copy link"
            compactCopyLinkLabel="Copy link"
            onCopyLink={() =>
              navigator.clipboard
                .writeText(location.origin + location.pathname)
                .then(() => setMessage("Link copied."))
                .catch(() => setError("Could not copy the link."))
            }
            formError={error || null}
            message={manage ? message || null : error || message || null}
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
                {domainSharing.options.map(({ value, label }) => (
                  <option key={value} value={value}>
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
            </section>
          )}
        </div>
      )}
    </div>
  );
}
