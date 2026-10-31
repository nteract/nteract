import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Observable, animationFrameScheduler, auditTime, fromEvent, merge } from "rxjs";
import { resolveCommentDraft } from "./comment-draft.mjs";
import { hasDraftText } from "./comment-composer.mjs";
import { COMMENTS_SHEET_QUERY } from "./comments-layout.mjs";
import { commentPopoverPosition, passageRect } from "./comment-popover.mjs";
import { CommentRichText } from "./CommentRichText.jsx";
import { useStore } from "./store.mjs";
import "./comments.css";

export const COMMENT_POPOVER_LABEL = "Comment on selection";

function useSheetLayout() {
  const [sheet, setSheet] = useState(() => matchMedia(COMMENTS_SHEET_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(COMMENTS_SHEET_QUERY);
    const update = () => setSheet(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return sheet;
}

const observe = (Observer, target, options) =>
  new Observable((subscriber) => {
    if (!target || typeof Observer !== "function") return;
    const observer = new Observer(() => subscriber.next());
    observer.observe(target, options);
    return () => observer.disconnect();
  });

/** Where the draft's passage is on screen: its highlighted segments, or the
 * block when the passage is not rendered. */
function anchorFor(container, blockId) {
  const marks = container?.querySelectorAll("[data-comment-draft]") ?? [];
  const passage = passageRect([...marks].flatMap((mark) => [...mark.getClientRects()]));
  if (passage) return passage;
  return (
    container?.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)?.getBoundingClientRect() ??
    null
  );
}

function visibleViewport() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0,
    top = viewport?.offsetTop ?? 0;
  return {
    left,
    top: Math.max(document.querySelector(".app-header")?.getBoundingClientRect().bottom ?? 0, top),
    right: left + (viewport?.width ?? innerWidth),
    bottom: top + (viewport?.height ?? innerHeight),
  };
}

/**
 * The inline comment composer. CommentComposer owns its lifecycle and draft;
 * this renders the popover beside the passage (or a bottom sheet on narrow
 * windows) while the composer is open or sending.
 */
export function CommentPopover({ composer, session, containerRef }) {
  const { state, composer: current, body } = useStore(composer.store);
  const visible = (state.name === "open" || state.name === "sending") && !!current;
  if (!visible) return null;
  return (
    <PopoverSurface
      composer={composer}
      session={session}
      containerRef={containerRef}
      state={state}
      current={current}
      body={body}
    />
  );
}

function PopoverSurface({ composer, session, containerRef, state, current, body }) {
  const dialog = useRef(null);
  const sheet = useSheetLayout();
  const [position, setPosition] = useState(null);
  const [draftError, setDraftError] = useState("");
  const sending = state.name === "sending";
  const blockId = current.draft.blockId;

  useLayoutEffect(() => {
    if (sheet) {
      setPosition(null);
      return;
    }
    const container = containerRef?.current ?? null;
    const place = () => {
      const element = dialog.current;
      if (!element) return;
      const box = element.getBoundingClientRect();
      const next = commentPopoverPosition({
        anchor: anchorFor(container, blockId),
        width: box.width,
        height: box.height,
        viewport: visibleViewport(),
      });
      setPosition((previous) =>
        previous?.left === next?.left &&
        previous?.top === next?.top &&
        previous?.placement === next?.placement
          ? previous
          : next,
      );
    };
    place();
    // Follow the passage through scrolling, resizing, the popover growing as
    // the draft does, and the Page re-rendering the highlight.
    const subscription = merge(
      fromEvent(window, "scroll", { capture: true, passive: true }),
      fromEvent(window, "resize"),
      window.visualViewport ? fromEvent(window.visualViewport, "resize") : [],
      window.visualViewport ? fromEvent(window.visualViewport, "scroll") : [],
      observe(globalThis.ResizeObserver, dialog.current),
      observe(globalThis.MutationObserver, container, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class"],
      }),
    )
      .pipe(auditTime(0, animationFrameScheduler))
      .subscribe(place);
    return () => subscription.unsubscribe();
  }, [sheet, containerRef, blockId, current.key]);

  useEffect(() => {
    // A pointer outside the popover closes it and keeps the text. The pointer
    // decides where focus goes. Menus portaled from the comment editor land
    // inside this dialog, so they count as inside.
    const subscription = fromEvent(document, "pointerdown").subscribe((event) => {
      if (!dialog.current || dialog.current.contains(event.target)) return;
      composer.dismiss({ returnFocus: false });
    });
    return () => subscription.unsubscribe();
  }, [composer]);

  let draftProblem = "";
  try {
    resolveCommentDraft(session.doc, current.draft);
  } catch (error) {
    draftProblem = error.message;
  }
  const disabled = sending || !session.canWrite;
  const canSend = !disabled && !draftProblem && !draftError && hasDraftText(body);
  const markdown = body?.markdown ?? body;
  const error = draftProblem
    ? `${draftProblem}.`
    : draftError || (state.name === "open" ? state.error : "");

  return (
    <dialog
      ref={dialog}
      open
      id="comment-popover"
      className={"comment-popover" + (sheet ? " comment-popover-sheet" : "")}
      aria-label={COMMENT_POPOVER_LABEL}
      data-placement={sheet ? "sheet" : (position?.placement ?? "below")}
      style={
        sheet
          ? undefined
          : position
            ? { left: position.left, top: position.top }
            : { visibility: "hidden" }
      }
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          if (canSend) composer.submit();
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        composer.dismiss({ returnFocus: true });
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) composer.submit();
        }}
      >
        <CommentRichText
          label={COMMENT_POPOVER_LABEL}
          value={markdown || ""}
          nativeSpans={body?.spans}
          onChange={(text, spans) => composer.change(spans ? { markdown: text, spans } : text)}
          onError={setDraftError}
          disabled={disabled}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="comment-form-actions comment-popover-actions">
          <button
            type="button"
            className="subtle-button"
            disabled={sending}
            onClick={() => composer.cancel()}
          >
            Cancel
          </button>
          <button className="primary" disabled={!canSend}>
            {sending ? "Commenting…" : "Comment"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
