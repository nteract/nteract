import { useEffect, useEffectEvent, useId, useReducer, useRef, useState } from "react";
import { defer } from "rxjs";
import { Share2 } from "lucide-react";
import { projectPath } from "../shared/routes.mjs";
import { ROLE_LABELS } from "./sharing-roles.mjs";

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
    const subscription = defer(() =>
      tool(state.name === "loading" ? "get_project_access" : "manage_project_access", {
        project_id: project.project_id,
        ...state.request,
      }),
    ).subscribe({
      next: (value) => dispatch({ type: "loaded", value }),
      error: (error) => dispatch({ type: "failed", error: error.message }),
    });
    return () => subscription.unsubscribe();
  }, [state, owner, project.project_id, tool]);
  const dismiss = useEffectEvent(() => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) dismiss();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
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
          <Share2 size={18} aria-hidden="true" /> Share
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
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <h2>Share Project</h2>
          <p>
            Project members can access every Page in this Project. Direct Page grants are managed
            separately and remain when membership is removed.
          </p>
          <button type="button" onClick={copyLink}>
            Copy Project link
          </button>
          <p role="status">
            {copyStatus ||
              state.message ||
              (state.name === "saving" ? "Updating Project access…" : "")}
          </p>
          {project.role === "unknown" ? (
            <p role="status">Loading Project access…</p>
          ) : (
            !owner && (
              <p>
                {ROLE_LABELS[project.role] || "Project access unavailable"}. Only the Project owner
                can manage members.
              </p>
            )
          )}
          {owner && (
            <>
              <p>
                Enter the person's exact email. Access stays pending until they open the Project
                while signed in with that verified email. No email is sent; share the Project link
                yourself.
              </p>
              {state.name === "loading" && <p role="status">Loading members…</p>}
              {state.name === "failed" && (
                <>
                  <p role="alert">{state.error}</p>
                  <button type="button" onClick={() => dispatch({ type: "load" })}>
                    Reload members
                  </button>
                </>
              )}
              {state.value && (
                <>
                  <ul>
                    {Object.entries(state.value.members ?? {})
                      .filter(([, member]) => Object.hasOwn(ROLE_LABELS, member.role))
                      .map(([id, member]) => (
                        <li key={id}>
                          <span>{member.email || member.displayName || id}</span>{" "}
                          <select
                            aria-label={`Role for ${member.email || member.displayName || id}`}
                            value={member.role}
                            disabled={state.name !== "ready"}
                            onChange={(event) =>
                              save({ action: "set_role", principal: id, role: event.target.value })
                            }
                          >
                            {Object.entries(ROLE_LABELS).map(([role, label]) => (
                              <option key={role} value={role}>
                                {label}
                              </option>
                            ))}
                          </select>{" "}
                          <button
                            type="button"
                            disabled={state.name !== "ready"}
                            onClick={() => save({ action: "set_role", principal: id, role: null })}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                  </ul>
                  {!!state.value.invites?.length && (
                    <section aria-label="Pending access">
                      <h3>Pending access</h3>
                      <ul>
                        {state.value.invites.map((invite) => (
                          <li key={invite.id}>
                            <span>
                              {invite.email}: {ROLE_LABELS[invite.role] || "Access unavailable"} ·{" "}
                              {invite.expiresAt <= Date.now() ? "Expired" : "Pending"}
                            </span>{" "}
                            <button
                              type="button"
                              disabled={state.name !== "ready"}
                              onClick={() =>
                                save({ action: "revoke_invite", invite_id: invite.id })
                              }
                            >
                              Revoke pending access
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (event.currentTarget.checkValidity())
                        save({ action: "invite", email: email.trim(), role });
                    }}
                  >
                    <label>
                      Email{" "}
                      <input
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                      />
                    </label>
                    <label>
                      Project role{" "}
                      <select value={role} onChange={(event) => setRole(event.target.value)}>
                        {Object.entries(ROLE_LABELS).map(([role, label]) => (
                          <option key={role} value={role}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" disabled={state.name !== "ready" || !email.trim()}>
                      Add access
                    </button>
                  </form>
                </>
              )}
              <p>Changes to live inherited access can take up to 15 seconds.</p>
            </>
          )}
          <button type="button" className="subtle-button" onClick={close}>
            Close
          </button>
        </section>
      )}
    </div>
  );
}
