// Connected agents: the account's agent connections, Disconnect for each,
// and Sign out everywhere. The machine (connected-agents-machine.mjs) decides
// every step; this file runs its effects and renders.
import { ContainerDialog, useContainerDialog } from "./ContainerDialog.jsx";
import * as machine from "./connected-agents-machine.mjs";
import { request } from "./request.mjs";

/** What a connection may do, from its OAuth scope. */
export function agentAccess(scope = "") {
  const scopes = new Set(scope.split(" "));
  const base = scopes.has("pages:write") ? "Read and edit" : "Read only";
  return scopes.has("pages:share") ? `${base}, share` : base;
}

function connectedOn(createdAt) {
  const at = createdAt ? new Date(createdAt) : null;
  return at && !Number.isNaN(at.getTime())
    ? `Connected ${at.toLocaleDateString(undefined, { dateStyle: "medium" })}`
    : "Connected earlier";
}

/** Whether a failed request means the host doesn't serve the route: a 404,
 * as JSON from the Worker or as a proxy's page from ingress. */
export const routeMissing = (error) => error?.status === 404 || error?.httpStatus === 404;

export function ConnectedAgents({ onClose, onSignedOut, onUnavailable, returnFocus }) {
  const [state, dispatch] = useContainerDialog(
    machine.initialAgents(),
    (effect, send) => {
      if (effect.type === "load")
        request("/api/auth/grants").then(
          (body) => send({ type: "loaded", agents: body.agents }),
          (error) =>
            send({ type: "loadFailed", message: error.message, unavailable: routeMissing(error) }),
        );
      else if (effect.type === "revoke")
        request(`/api/auth/grants/${encodeURIComponent(effect.id)}/revoke`, {
          method: "POST",
        }).then(
          () => send({ type: "revoked", id: effect.id }),
          (error) => send({ type: "revokeFailed", id: effect.id, message: error.message }),
        );
      else if (effect.type === "signOut")
        request("/api/auth/logout-all", { method: "POST" }).then(
          () => send({ type: "signedOut" }),
          (error) => send({ type: "signOutFailed", message: error.message }),
        );
      else if (effect.type === "finish") onSignedOut();
      else if (effect.type === "unavailable") onUnavailable?.();
      else if (effect.type === "dismiss") onClose();
    },
    machine,
  );
  const busy = machine.agentsBusy(state);
  const { list } = state;
  return (
    <ContainerDialog
      id="connected-agents-title"
      title="Connected agents"
      className="connected-agents-dialog"
      dispatch={dispatch}
      busy={busy}
      returnFocus={returnFocus}
    >
      <div className="container-form">
        <p className="muted container-note">
          Agents connected through Pages sign-in act for you until you disconnect them. Agents using
          an Anaconda API key aren't listed here; manage API keys in your Anaconda account.
        </p>
        {list.status === "loading" && <p role="status">Loading…</p>}
        {list.status === "unavailable" && (
          <p className="muted">Connected agents aren't available on this server yet.</p>
        )}
        {list.status === "failed" && (
          <div className="connected-agents-failed">
            <p className="error picker-error" role="alert">
              {list.message}
            </p>
            <button
              type="button"
              className="subtle-button"
              onClick={() => dispatch({ type: "retry" })}
            >
              Try again
            </button>
          </div>
        )}
        {list.status === "ready" && list.agents.length === 0 && (
          <p className="muted">No agents are connected.</p>
        )}
        {list.status === "ready" && list.agents.length > 0 && (
          <ul className="connected-agents" aria-label="Connected agents">
            {list.agents.map((agent) => (
              <li key={agent.id}>
                <div>
                  <strong>{agent.name}</strong>
                  <span className="muted">
                    {connectedOn(agent.created_at)} · {agentAccess(agent.scope)}
                  </span>
                </div>
                <button
                  type="button"
                  className="subtle-button"
                  disabled={busy || state.name !== "browsing"}
                  aria-label={`Disconnect ${agent.name}`}
                  onClick={() => dispatch({ type: "revoke", id: agent.id })}
                >
                  {state.revoking === agent.id ? "Disconnecting…" : "Disconnect"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {state.error && (
          <p className="error picker-error" role="alert">
            {state.error}
          </p>
        )}
        {list.status !== "unavailable" && (
          <div className="connected-agents-everywhere">
            {state.name === "browsing" ? (
              <>
                <p className="muted container-note">
                  Sign out of Pages in every browser and disconnect every agent connected through
                  Pages sign-in. API keys keep working until you revoke them in Anaconda.
                </p>
                <div className="container-actions">
                  <button
                    type="button"
                    className="subtle-button danger"
                    disabled={busy}
                    onClick={() => dispatch({ type: "confirm" })}
                  >
                    Sign out everywhere
                  </button>
                </div>
              </>
            ) : (
              <>
                <p role="status">
                  Sign out of every browser, this one included, and disconnect every agent connected
                  through Pages sign-in?
                </p>
                <div className="container-actions">
                  <button
                    type="button"
                    className="subtle-button"
                    disabled={state.name !== "confirming"}
                    onClick={() => dispatch({ type: "cancel" })}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary danger-action"
                    disabled={state.name !== "confirming"}
                    onClick={() => dispatch({ type: "signOut" })}
                  >
                    {state.name === "confirming" ? "Sign out everywhere" : "Signing out…"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </ContainerDialog>
  );
}
