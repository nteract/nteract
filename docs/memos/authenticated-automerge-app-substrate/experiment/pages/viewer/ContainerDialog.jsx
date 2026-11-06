// The modal shell and machine binding shared by the New Project, Move to… and
// Connected agents dialogs. The machine (container-dialog-machine.mjs, or the
// one a dialog passes) decides every step; this file only runs its effects
// and renders.
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import * as containerMachine from "./container-dialog-machine.mjs";

/** Run a dialog machine from `initial`. `run(effect, dispatch)` performs one
 * effect; events it dispatches after the dialog unmounts are dropped.
 * `machine` supplies `transition` and `openingEffects`. */
export function useContainerDialog(initial, run, machine = containerMachine) {
  const [state, setState] = useState(initial);
  const current = useRef(state);
  const runner = useRef(run);
  // A dialog's machine is fixed for its lifetime.
  const steps = useRef(machine);
  const mounted = useRef(true);
  runner.current = run;
  const dispatch = useCallback((event) => {
    if (!mounted.current) return;
    const { state: next, effects } = steps.current.transition(current.current, event);
    if (next !== current.current) {
      current.current = next;
      setState(next);
    }
    for (const effect of effects) runner.current(effect, dispatch);
  }, []);
  useEffect(() => {
    mounted.current = true;
    for (const effect of steps.current.openingEffects(current.current))
      runner.current(effect, dispatch);
    return () => {
      mounted.current = false;
    };
  }, [dispatch]);
  return [state, dispatch];
}

/** A modal <dialog> that asks the machine before it closes: Escape and the
 * backdrop dispatch `close`, which a write in flight ignores. If the browser
 * closes the dialog anyway (the native `close` event) while `busy`, it opens
 * again so the write's answer, a failure included, stays visible. When the
 * dialog goes away, focus returns to `returnFocus()`, the control that
 * opened it, as SharingControls' `returnFocus` does. */
export function ContainerDialog({
  id,
  title,
  className = "",
  dispatch,
  busy = false,
  returnFocus,
  children,
}) {
  const dialog = useRef(null);
  const leaving = useRef(false);
  const state = useRef({ busy, dispatch, returnFocus });
  state.current = { busy, dispatch, returnFocus };
  useEffect(() => {
    const element = dialog.current;
    leaving.current = false;
    if (!element.open) element.showModal();
    element.querySelector("input, select")?.focus();
    return () => {
      leaving.current = true;
      if (element.open) element.close();
      const target = state.current.returnFocus?.();
      if (target?.isConnected) target.focus();
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
      onClose={() => {
        if (leaving.current) return;
        const element = dialog.current;
        // A write in flight can't be taken back: keep its answer on screen.
        if (state.current.busy) {
          if (element && !element.open) element.showModal();
          return;
        }
        state.current.dispatch({ type: "close" });
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
