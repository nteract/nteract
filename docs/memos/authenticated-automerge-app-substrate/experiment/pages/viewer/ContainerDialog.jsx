// The modal shell and machine binding shared by the New Project and Move to…
// dialogs. The machine (container-dialog-machine.mjs) decides every step;
// this file only runs its effects and renders.
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { openingEffects, transition } from "./container-dialog-machine.mjs";

/** Run the dialog machine from `initial`. `run(effect, dispatch)` performs
 * one effect; events it dispatches after the dialog unmounts are dropped. */
export function useContainerDialog(initial, run) {
  const [state, setState] = useState(initial);
  const current = useRef(state);
  const runner = useRef(run);
  const mounted = useRef(true);
  runner.current = run;
  const dispatch = useCallback((event) => {
    if (!mounted.current) return;
    const { state: next, effects } = transition(current.current, event);
    if (next !== current.current) {
      current.current = next;
      setState(next);
    }
    for (const effect of effects) runner.current(effect, dispatch);
  }, []);
  useEffect(() => {
    mounted.current = true;
    for (const effect of openingEffects(current.current)) runner.current(effect, dispatch);
    return () => {
      mounted.current = false;
    };
  }, [dispatch]);
  return [state, dispatch];
}

/** A modal <dialog> that asks the machine before it closes: Escape and the
 * backdrop dispatch `close`, which a write in flight ignores. */
export function ContainerDialog({ id, title, className = "", dispatch, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element.open) element.showModal();
    element.querySelector("input, select")?.focus();
    return () => {
      if (element.open) element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`page-picker container-dialog ${className}`}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        dispatch({ type: "close" });
      }}
      onClick={(event) => {
        if (event.target === dialog.current) dispatch({ type: "close" });
      }}
    >
      <div className="picker-content">
        <div className="picker-heading">
          <h2 id={id}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={`Close ${title}`}
            onClick={() => dispatch({ type: "close" })}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
