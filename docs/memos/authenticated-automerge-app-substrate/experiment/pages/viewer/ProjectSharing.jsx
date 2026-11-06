import { useEffect, useEffectEvent, useId, useReducer, useRef, useState } from "react";
import { defer } from "rxjs";
import { Share2 } from "lucide-react";
import {
  SharingPanel,
  nativePrimitives,
} from "../../../../../../src/components/sharing/SharingPanel.tsx";
import { projectPath } from "../shared/routes.mjs";
import { ROLE_LABELS } from "./sharing-roles.mjs";
import "./sharing-panel.css";

export function projectSharingTransition(state, event) {
  if (event.type === "load" && !["loading", "saving"].includes(state.name))
    return { name: "loading", value: null };
  if (event.type === "save" && state.name === "ready")
    return { name: "saving", value: state.value, request: event.request };
  if (event.type === "loaded" && ["loading", "saving"].includes(state.name))
    return {
      name: "ready",
      value: event.value,
      message: state.name === "saving" ? "Project access updated." : "",
    };
  if (event.type === "failed" && ["loading", "saving"].includes(state.name))
    return { name: "failed", value: null, error: event.error };
  return state;
}

const ROLE_OPTIONS = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
const primitives = {
  ...nativePrimitives,
  ScopeSelect: ({ id, value, onValueChange }) => (
    <select id={id} value={value} onChange={(event) => onValueChange(event.target.value)}>
      {ROLE_OPTIONS.map(({ value, label }) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  ),
};

const row = (value) => ({
  detail: "",
  title: value.label,
  stateLabel: null,
  stateTone: null,
  removable: false,
  ...value,
});

/**
 * Rows for the shared panel. The owner row comes from the signed-in identity:
 * only the owner reads the ACL, so the viewer is the owner. Members carry
 * `role` so the panel renders their role picker; invites are revoke-only.
 */
export function projectAccessRows(value, identity, now = Date.now()) {
  if (!value) return [];
  const rows = [
    row({
      id: "owner",
      kind: "acl",
      label: identity?.displayName || "You",
      detail: identity?.email || "",
      badge: "Owner",
    }),
  ];
  for (const [principal, member] of Object.entries(value.members ?? {})) {
    if (!Object.hasOwn(ROLE_LABELS, member.role)) continue;
    rows.push(
      row({
        id: principal,
        kind: "acl",
        principal,
        label: member.displayName || member.email || "Collaborator",
        detail: member.displayName ? member.email || "" : "",
        badge: ROLE_LABELS[member.role],
        role: member.role,
        removable: true,
      }),
    );
  }
  for (const invite of value.invites ?? []) {
    const expired = invite.expiresAt <= now;
    rows.push(
      row({
        id: invite.id,
        kind: "invite",
        label: invite.email,
        detail: expired ? "Invite expired" : "Waiting for them to open the Project",
        badge: ROLE_LABELS[invite.role] || "Access unavailable",
        stateLabel: expired ? "Expired" : "Pending",
        stateTone: expired ? null : "pending",
        removable: true,
      }),
    );
  }
  return rows;
}

function description(project, owner) {
  if (owner) return "Members can open every Page in this Project.";
  if (project.role === "unknown") return "Loading Project access…";
  const role = ROLE_LABELS[project.role];
  return `${role ? `${role}.` : "Project access unavailable."} Only the Project owner can manage members.`;
}

/** Project ACLs are separate from a Page's direct grants. No email lookup. */
export function ProjectSharing({
  project,
  session,
  tool,
  open,
  onOpenChange,
  trigger = true,
  returnFocus,
  panelRef,
  triggerRef,
}) {
  const [state, dispatch] = useReducer(projectSharingTransition, { name: "idle", value: null });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [copyStatus, setCopyStatus] = useState("");
  const dialogId = useId();
  const panel = useRef(null);
  const root = useRef(null);
  const button = useRef(null);
  const owner = project.role === "owner" && !session?.authRequired;
  useEffect(() => {
    if (open && owner) dispatch({ type: "load" });
    if (open) panel.current?.focus();
  }, [open, owner]);
  useEffect(() => {
    if (!owner || !["loading", "saving"].includes(state.name)) return;
    const request = state.request;
    const subscription = defer(() =>
      tool(state.name === "loading" ? "get_project_access" : "manage_project_access", {
        project_id: project.project_id,
        ...request,
      }),
    ).subscribe({
      next: (value) => {
        if (request?.action === "invite") setEmail("");
        dispatch({ type: "loaded", value });
      },
      error: (error) => dispatch({ type: "failed", error: error.message }),
    });
    return () => subscription.unsubscribe();
  }, [state, owner, project.project_id, tool]);
  const dismiss = useEffectEvent(() => onOpenChange(false));
  const escape = useEffectEvent(() => close());
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) dismiss();
    };
    // Document-level: a button that disables mid-save drops focus to <body>,
    // and Escape must still close the panel.
    const key = (event) => {
      if (event.key === "Escape") escape();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const save = (change) => {
    setCopyStatus("");
    dispatch({
      type: "save",
      request: {
        ...change,
        expected_revision: state.value.revision,
        idempotency_key: crypto.randomUUID(),
      },
    });
  };
  const close = () => {
    onOpenChange(false);
    (trigger ? button : returnFocus)?.current?.focus();
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        new URL(projectPath(project.project_id), location.origin).href,
      );
      setCopyStatus("Project link copied.");
    } catch {
      setCopyStatus("Could not copy the Project link.");
    }
  };
  const request = state.name === "saving" ? state.request : null;
  const busyAction = request
    ? request.action === "invite"
      ? "invite"
      : (request.principal ?? request.invite_id)
    : null;
  const failed = state.name === "failed";
  const message =
    (failed && state.error) ||
    copyStatus ||
    state.message ||
    (state.name === "saving" ? "Updating Project access…" : "");
  return (
    <div className="page-sharing" ref={root}>
      {trigger && (
        <button
          ref={(node) => {
            button.current = node;
            if (triggerRef) triggerRef.current = node;
          }}
          type="button"
          className="subtle-button"
          aria-haspopup="dialog"
          aria-controls={dialogId}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <Share2 size={17} aria-hidden="true" />
          <span>Share</span>
        </button>
      )}
      {open && (
        <section
          className="page-sharing-popover project-sharing-panel"
          role="dialog"
          aria-label="Share Project"
          id={dialogId}
          tabIndex={-1}
          ref={(node) => {
            panel.current = node;
            if (panelRef) panelRef.current = node;
          }}
        >
          <SharingPanel
            resourceLabel="Project"
            title="Share Project"
            description={description(project, owner)}
            sections={{
              publicAccess: false,
              invites: owner && !failed,
              accessRequests: false,
              runtimeAccess: false,
            }}
            emptyAccessMessage={
              failed
                ? "Members could not be loaded."
                : owner
                  ? "Only you have access."
                  : "Members are visible to the Project owner."
            }
            accessProjection={{
              accessRows: owner ? projectAccessRows(state.value, session?.identity) : [],
              accessSummary: null,
              accessRequestRows: [],
              accessRequestSummary: null,
              runtimeAccessRows: [],
              runtimeAccessSummary: null,
            }}
            busyAction={busyAction}
            copyLinkLabel="Copy Project link"
            compactCopyLinkLabel="Copy link"
            onCopyLink={copyLink}
            formError={null}
            message={message || null}
            messageKind={failed ? "error" : "info"}
            inviteEmail={email}
            onInviteEmailChange={setEmail}
            inviteScope={role}
            onInviteScopeChange={setRole}
            inviteReady={state.name === "ready" && !!email.trim()}
            onSubmitInvite={(event) => {
              event.preventDefault();
              if (email.trim() && event.currentTarget.checkValidity())
                save({ action: "invite", email: email.trim(), role });
            }}
            onRemoveAccessRow={(row) =>
              save(
                row.kind === "invite"
                  ? { action: "revoke_invite", invite_id: row.id }
                  : { action: "set_role", principal: row.principal, role: null },
              )
            }
            roleOptions={ROLE_OPTIONS}
            onChangeAccessRowRole={(row, role) =>
              save({ action: "set_role", principal: row.principal, role })
            }
            onResolveAccessRequest={() => {}}
            onTogglePublicAccess={() => {}}
            publicBusy={false}
            publicEnabled={false}
            showInitialAccessLoading={
              project.role === "unknown" || (owner && ["idle", "loading"].includes(state.name))
            }
            primitives={primitives}
            concealEmails
          />
          {failed && (
            <button
              type="button"
              className="subtle-button page-sharing-retry"
              onClick={() => dispatch({ type: "load" })}
            >
              Reload members
            </button>
          )}
          {owner && !failed && (
            <p className="page-sharing-note">
              No email is sent. Share the Project link yourself; access stays pending until they
              open it signed in with that verified email. Changes reach open Pages within 15
              seconds.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
