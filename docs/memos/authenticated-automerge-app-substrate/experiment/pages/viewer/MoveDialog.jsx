// Move to…: pick Your items or one of your Projects, optionally a parent Page
// there, then move_page. Native <select>s keep it usable on phones.
import { ContainerDialog, useContainerDialog } from "./ContainerDialog.jsx";
import { formReady, initialMove } from "./container-dialog-machine.mjs";
import { loadParentChoices, moveDestinations, movePage } from "./container-actions.mjs";

const YOUR_ITEMS = "your-items";

/** `origin` is where the Page is (`{ target, parent_id }`, see moveOrigin);
 * the form starts there and Move stays off until it changes. `currentProject`
 * (`{ project_id, title }`) names the Page's Project in case `projects`
 * doesn't list it yet. */
export function MoveDialog({
  tool,
  pageId,
  title,
  origin,
  currentProject,
  projects,
  returnFocus,
  onClose,
  onMoved,
}) {
  const [state, dispatch] = useContainerDialog(initialMove(origin ?? null), (effect, send) => {
    if (effect.type === "loadParents")
      loadParentChoices(tool, effect.target, pageId).then(
        (rows) => send({ type: "parentsLoaded", target: effect.target, rows }),
        (error) => send({ type: "parentsFailed", target: effect.target, message: error.message }),
      );
    else if (effect.type === "write")
      movePage(tool, pageId, effect.form, effect.attempt).then(
        (result) => send({ type: "succeeded", result }),
        (error) => send({ type: "failed", message: error.message, attempt: error.attempt }),
      );
    else if (effect.type === "finish") onMoved(effect.result);
    else if (effect.type === "dismiss") onClose();
  });
  const submitting = state.name !== "editing";
  const destinations = moveDestinations(projects, currentProject);
  const { parents } = state;
  return (
    <ContainerDialog
      id="move-dialog-title"
      title={`Move “${title || "Untitled"}”`}
      className="move-dialog"
      dispatch={dispatch}
      busy={state.name === "submitting"}
      returnFocus={returnFocus}
    >
      <form
        className="container-form"
        onSubmit={(event) => {
          event.preventDefault();
          dispatch({ type: "submit" });
        }}
      >
        <label className="container-field">
          <span>Move to</span>
          <select
            value={state.form.target ?? YOUR_ITEMS}
            disabled={submitting}
            onChange={(event) =>
              dispatch({
                type: "edit",
                form: { target: event.target.value === YOUR_ITEMS ? null : event.target.value },
              })
            }
          >
            {destinations.map((destination) => (
              <option
                key={destination.target ?? YOUR_ITEMS}
                value={destination.target ?? YOUR_ITEMS}
              >
                {destination.title}
              </option>
            ))}
          </select>
        </label>
        <label className="container-field">
          <span>
            Under <span className="muted">(optional)</span>
          </span>
          <select
            value={state.form.parent_id ?? ""}
            disabled={submitting || parents.status !== "ready"}
            onChange={(event) =>
              dispatch({ type: "edit", form: { parent_id: event.target.value || null } })
            }
          >
            <option value="">Top level</option>
            {state.form.parent_id &&
              !parents.rows.some((row) => row.page_id === state.form.parent_id) && (
                // The Page's own parent, until its list loads.
                <option value={state.form.parent_id}>Current parent</option>
              )}
            {parents.rows.map((row) => (
              <option key={row.page_id} value={row.page_id}>
                {`${"\u00a0\u00a0".repeat(row.depth)}${row.title}`}
              </option>
            ))}
          </select>
        </label>
        {parents.status === "loading" && (
          <p className="muted" role="status">
            Loading Pages…
          </p>
        )}
        {parents.status === "failed" && (
          <p className="muted" role="status">
            Couldn't list Pages there; the Page can still move to the top level.
          </p>
        )}
        <p className="muted container-note">Sub-pages move with it.</p>
        {state.error && (
          <p className="error picker-error" role="alert">
            {state.error}
          </p>
        )}
        <div className="container-actions">
          <button
            type="button"
            className="subtle-button"
            disabled={submitting}
            onClick={() => dispatch({ type: "close" })}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={submitting || !formReady("move", state.form, state.origin)}
          >
            {submitting ? "Moving…" : "Move"}
          </button>
        </div>
      </form>
    </ContainerDialog>
  );
}
