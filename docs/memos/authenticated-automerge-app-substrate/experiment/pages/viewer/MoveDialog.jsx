import { useEffect, useRef, useState } from "react";
import { Boxes, FileText, Home, Inbox, X } from "lucide-react";
import { moveDialogMachine } from "./move-dialog-machine.mjs";
import { listAllPages } from "./page-list.mjs";
import { listProjects, moveDestinations, movePage } from "./projects.mjs";

/**
 * "Move to…": Your items, each Project, and the Pages in each Project to nest
 * under. `target` ({ page_id, title }) opens the dialog; null closes it.
 * `send` steps the machine and then runs the effects it returned, so every
 * effect belongs to exactly one transition. A rejected event (a late reply,
 * a click while a move runs) changes nothing.
 */
export function MoveDialog({ tool, target, onClose, onMoved }) {
  const dialog = useRef(null);
  const attempts = useRef(0);
  const current = useRef(moveDialogMachine.initial);
  const [state, setState] = useState(moveDialogMachine.initial);
  // Keep the latest callbacks without re-running effects for new closures.
  const callbacks = useRef({ onClose, onMoved });
  callbacks.current = { onClose, onMoved };

  function send(event) {
    const result = moveDialogMachine.step(current.current, event);
    if (result.rejected !== undefined) return;
    current.current = result.state;
    setState(result.state);
    for (const effect of result.effects) run(effect);
  }
  function run(effect) {
    if (effect.type === "load")
      void Promise.all([listProjects(tool), listAllPages(tool)]).then(
        ([projects, listing]) =>
          send({
            type: "loaded",
            attempt: effect.attempt,
            destinations: moveDestinations({
              pageId: effect.page_id,
              projects,
              pages: listing.pages ?? [],
            }),
          }),
        (error) =>
          send({
            type: "loadFailed",
            attempt: effect.attempt,
            error: error?.message || "Couldn't load destinations",
          }),
      );
    else if (effect.type === "move")
      void movePage(tool, effect.page_id, effect.destination).then(
        (receipt) => send({ type: "moved", attempt: effect.attempt, receipt }),
        (error) =>
          send({
            type: "moveFailed",
            attempt: effect.attempt,
            error: error?.message || "Couldn't move this Page",
          }),
      );
    else if (effect.type === "notify") callbacks.current.onMoved(effect.receipt);
  }

  useEffect(() => {
    if (target) send({ type: "open", attempt: ++attempts.current, page: target });
    else send({ type: "close" });
  }, [target?.page_id]);

  const open = state.name !== "closed";
  useEffect(() => {
    const element = dialog.current;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  const close = () => {
    if (state.name === "moving") return;
    send({ type: "close" });
    callbacks.current.onClose();
  };
  const title = state.page?.title || "Untitled";
  const moving = state.name === "moving";
  return (
    <dialog
      ref={dialog}
      className="page-picker move-dialog"
      aria-labelledby="move-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      {open && (
        <form
          className="picker-content"
          onSubmit={(event) => {
            event.preventDefault();
            send({ type: "submit" });
          }}
        >
          <div className="picker-heading">
            <h2 id="move-dialog-title">Move “{title}” to…</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close Move"
              onClick={close}
              disabled={moving}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          {state.name === "loading" && (
            <p className="muted move-status" role="status">
              Loading…
            </p>
          )}
          {state.name === "failed" && (
            <p className="error picker-error" role="alert">
              {state.error}
            </p>
          )}
          {state.error && state.name === "choosing" && (
            <p className="error picker-error" role="alert">
              {state.error}
            </p>
          )}
          {state.destinations && (
            <div className="picker-list move-destinations" role="radiogroup" aria-label="Move to">
              {state.destinations.map((row, index) => {
                const Icon = row.key === "your-items" ? Inbox : row.home ? Home : row.parent_id ? FileText : Boxes;
                return (
                  <label
                    key={row.key}
                    className={`picker-page move-destination${row.disabled ? " disabled" : ""}`}
                    style={{ paddingInlineStart: `${0.8 + row.depth * 1.1}rem` }}
                    title={row.reason}
                  >
                    <input
                      type="radio"
                      name="move-destination"
                      value={row.key}
                      checked={state.selected === index}
                      disabled={row.disabled || moving}
                      onChange={() => send({ type: "select", index })}
                    />
                    <Icon size={18} aria-hidden="true" />
                    <span>{row.label}</span>
                    {row.home && !row.reason && <span className="page-card-meta">Home</span>}
                    {row.reason && <span className="page-card-meta">{row.reason}</span>}
                  </label>
                );
              })}
            </div>
          )}
          <div className="move-actions">
            <button type="button" className="subtle-button" onClick={close} disabled={moving}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={state.name !== "choosing" || state.selected === null}
            >
              {moving ? "Moving…" : "Move"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
