import React, { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { PAGE_FORMAT_UNSUPPORTED } from "./format-gate.mjs";
import {
  UNOPENED_INITIAL,
  trashArguments,
  trashOutcome,
  unopenedAction,
  unopenedPageStep,
} from "./unopened-page.mjs";

/** Shown in place of a Page whose host refuses its document format, when no
 * session opened. The owner can move it to Trash from here (unopened-page.mjs);
 * anyone else sees the refusal alone. `principal` is the signed-in account
 * the host checks the move against; mount one per Page and account. */
export function UnopenedPage({ pageId, principal, request, tool, onTrashed, onOpenTrash, onHome }) {
  const [state, setState] = useState(UNOPENED_INITIAL);
  const current = useRef(UNOPENED_INITIAL);
  const alive = useRef(true);
  const check = () =>
    void request(`/api/access?page=${encodeURIComponent(pageId)}`).then(
      (answer) => dispatch({ type: "answered", access: answer?.access }),
      () => dispatch({ type: "unanswered" }),
    );
  const dispatch = (event) => {
    if (!alive.current) return;
    const { state: next, effects } = unopenedPageStep(current.current, event);
    current.current = next;
    setState(next);
    for (const effect of effects) {
      if (effect.type === "leave") onTrashed(pageId);
      else if (effect.type === "check") check();
      else if (effect.type === "trash")
        void tool(
          "delete_page",
          trashArguments({ pageId, principal, nonce: effect.nonce, heads: undefined }),
        ).then(
          (result) => dispatch(trashOutcome(undefined, result)),
          (error) => dispatch(trashOutcome(error)),
        );
    }
  };
  useEffect(() => {
    alive.current = true;
    check();
    return () => {
      alive.current = false;
    };
  }, []);
  const action = unopenedAction(state);
  return (
    <main className="welcome unopened-page" data-state={state.name}>
      <div className="access-notice" role="status">
        <h1>This Page can't be opened</h1>
        <p>{PAGE_FORMAT_UNSUPPORTED}</p>
        {state.message && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
        {action === "trash" && (
          <button
            type="button"
            className="danger"
            disabled={state.name === "trashing"}
            onClick={() => dispatch({ type: "trash", nonce: crypto.randomUUID() })}
          >
            <Trash2 size={15} aria-hidden="true" />{" "}
            {state.name === "trashing" ? "Moving to Trash…" : "Move to Trash"}
          </button>
        )}
        {action === "trashView" && (
          <button type="button" onClick={onOpenTrash}>
            <Trash2 size={15} aria-hidden="true" /> Open Trash
          </button>
        )}
        <button type="button" className="subtle-button" onClick={onHome}>
          Back to your Pages
        </button>
      </div>
    </main>
  );
}
