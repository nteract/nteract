import { themeStore } from "./theme.mjs";
import { safeUrl } from "../model/marks.mjs";

export const IMAGE_INITIAL = Object.freeze({ phase: "detached", request: null });

// Each attempt owns a fresh request object and a fresh img. No callback from
// an earlier theme, source or attachment can settle the current attempt.
export function imageTransition(state, event) {
  if (event.type === "detach") return IMAGE_INITIAL;
  if (event.type === "source") {
    const src = safeUrl(event.src) ? event.src : null;
    const dark = safeUrl(event.dark_src) ? event.dark_src : null;
    const preferred = event.theme === "dark" && dark ? dark : src;
    return preferred
      ? { phase: "preferred", src, url: preferred, request: {} }
      : { phase: "failed", src, request: null };
  }
  if (!["preferred", "fallback"].includes(state.phase) || event.request !== state.request)
    return state;
  if (event.type === "load") return { ...state, phase: "ready" };
  if (event.type === "error")
    return state.phase === "preferred" && state.src && state.url !== state.src
      ? { ...state, phase: "fallback", url: state.src, request: {} }
      : { ...state, phase: "failed" };
  return state;
}

// Browser-native lazy loading owns the wait. There is deliberately no timer:
// an offscreen image must not fail merely because no request has started.
export function imageLifecycle(dom, attrs, { store = themeStore } = {}) {
  let state = IMAGE_INITIAL,
    unsubscribe = null;
  const dispatch = (event) => {
    const next = imageTransition(state, event);
    if (next === state) return;
    const previous = state;
    state = next;
    dom.dataset.imageState = state.phase;
    if (state.phase === "detached") {
      dom.replaceChildren();
      return;
    }
    if (state.request !== previous.request && state.request) {
      const request = state.request;
      const image = dom.ownerDocument.createElement("img");
      image.alt = attrs.alt ?? "";
      if (attrs.title != null) image.title = attrs.title;
      image.loading = "lazy";
      image.onload = () => dispatch({ type: "load", request });
      image.onerror = () => dispatch({ type: "error", request });
      dom.replaceChildren(image);
      image.src = state.url;
    } else if (state.phase === "failed") {
      const notice = dom.ownerDocument.createElement("span");
      notice.textContent = attrs.alt ? `Image unavailable: ${attrs.alt}` : "";
      if (attrs.alt) {
        notice.setAttribute("role", "img");
        notice.setAttribute("aria-label", attrs.alt);
      } else notice.setAttribute("aria-hidden", "true");
      dom.replaceChildren(notice);
    }
  };
  const update = () => dispatch({ type: "source", ...attrs, theme: store.getSnapshot().resolved });
  return {
    connect() {
      if (unsubscribe) return;
      unsubscribe = store.subscribe(update);
      update();
    },
    disconnect() {
      unsubscribe?.();
      unsubscribe = null;
      dispatch({ type: "detach" });
    },
  };
}
