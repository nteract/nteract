// New Project: a title and an optional description, then create_project.
// On success the caller opens the new Project.
import { ContainerDialog, useContainerDialog } from "./ContainerDialog.jsx";
import { formReady, initialCreate } from "./container-dialog-machine.mjs";
import { createProject } from "./container-actions.mjs";

export function ProjectCreator({ tool, onClose, onCreated }) {
  const [state, dispatch] = useContainerDialog(initialCreate(), (effect, send) => {
    if (effect.type === "write")
      createProject(tool, effect.form, effect.attempt).then(
        (result) => send({ type: "succeeded", result }),
        (error) => send({ type: "failed", message: error.message, attempt: error.attempt }),
      );
    else if (effect.type === "finish") onCreated(effect.result);
    else if (effect.type === "dismiss") onClose();
  });
  const submitting = state.name !== "editing";
  return (
    <ContainerDialog id="project-creator-title" title="New Project" dispatch={dispatch}>
      <form
        className="container-form"
        onSubmit={(event) => {
          event.preventDefault();
          dispatch({ type: "submit" });
        }}
      >
        <label className="container-field">
          <span>Title</span>
          <input
            value={state.form.title}
            maxLength={200}
            required
            disabled={submitting}
            onChange={(event) => dispatch({ type: "edit", form: { title: event.target.value } })}
          />
        </label>
        <label className="container-field">
          <span>
            Description <span className="muted">(optional)</span>
          </span>
          <textarea
            rows={3}
            maxLength={2000}
            value={state.form.description}
            disabled={submitting}
            onChange={(event) =>
              dispatch({ type: "edit", form: { description: event.target.value } })
            }
          />
        </label>
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
            disabled={submitting || !formReady("create", state.form)}
          >
            {submitting ? "Creating…" : "Create Project"}
          </button>
        </div>
      </form>
    </ContainerDialog>
  );
}
