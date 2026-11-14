import React, { useEffect, useId, useMemo, useReducer } from "react";
import { defer } from "rxjs";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Globe,
  Image,
  Info,
  LockKeyhole,
  Upload,
} from "lucide-react";
import { PRODUCT_NAME } from "../shared/product.mjs";
import { request } from "./request.mjs";
import { uploadPageImage } from "./image-upload.mjs";
import { previewEditorTransition } from "./published-preview-state.mjs";
import { previewVisuals, renderPublishedPreview } from "./published-preview-image.mjs";
import "./published-preview.css";

export function PublishedPreview({ session, onBack }) {
  const id = useId();
  const visuals = useMemo(() => previewVisuals(), []);
  const [state, dispatch] = useReducer(previewEditorTransition, null, () => ({
    name: "loading",
    draft: { title: session.snapshot()?.title || "Untitled Page", description: "", visual: "text" },
    value: null,
    prepared: null,
    error: null,
  }));
  const endpoint = `/api/link-preview?page=${encodeURIComponent(session.pageId)}`;
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    if (!["loading", "rendering", "uploading", "publishing", "unpublishing"].includes(state.name))
      return;
    const subscription = defer(async () => {
      if (state.name === "loading")
        return { type: "loaded", value: await request(endpoint, { signal }) };
      if (state.name === "rendering") {
        const blob = await renderPublishedPreview(state.draft, visuals, signal);
        // The viewer CSP permits data images, not blob URLs. Display the same
        // PNG bytes that uploadPageImage will send after approval.
        const bytes = new Uint8Array(await blob.arrayBuffer());
        signal.throwIfAborted();
        const url = `data:image/png;base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`;
        return { type: "prepared", prepared: { blob, url } };
      }
      if (state.name === "uploading")
        return {
          type: "uploaded",
          asset: await uploadPageImage(session.pageId, state.prepared.blob, signal),
        };
      const value = await request(endpoint, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: state.name === "publishing" ? "publish" : "unpublish",
          expected_revision: state.value.revision,
          nonce: state.nonce,
          ...(state.name === "publishing" && {
            title: state.draft.title,
            description: state.draft.description,
            asset_id: state.asset.asset_id,
          }),
        }),
      });
      return { type: "saved", value };
    }).subscribe({
      next: (event) => dispatch(event),
      error: (error) => dispatch({ type: "failed", error: error.message }),
    });
    return () => {
      controller.abort();
      subscription.unsubscribe();
    };
  }, [state.name, state.nonce, endpoint, session, visuals]);
  const ready = state.name === "ready";
  const edit = (patch) => dispatch({ type: "edit", patch });
  const published = state.value?.snapshot;
  const showPublished = published && !state.edited && !state.prepared;
  const busy = !["ready", "failed", "loading"].includes(state.name);
  return (
    <section className="published-preview" aria-labelledby={`${id}-title`}>
      <header className="published-preview-header">
        {onBack && (
          <button
            className="preview-back"
            type="button"
            aria-label="Back to sharing"
            onClick={onBack}
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <h2 id={`${id}-title`}>Link preview</h2>
        <details className="preview-info">
          <summary aria-label="About link previews" title="About link previews">
            <Info size={15} />
          </summary>
          <p>
            Only the approved preview is public; Page access stays the same. Edits don’t update it
            automatically. Other services may cache a copy after removal.
          </p>
        </details>
        <span className="preview-publication-state" data-published={!!published}>
          {published ? <Globe size={13} /> : <LockKeyhole size={13} />}
          {published ? "Published" : "Not published"}
        </span>
      </header>
      {state.name === "loading" ? (
        <p className="preview-loading" role="status">
          Loading preview settings…
        </p>
      ) : (
        <>
          <div className="published-preview-body">
            <figure className="preview-card">
              {state.prepared ? (
                <img
                  className="published-preview-image"
                  src={state.prepared.url}
                  alt="Exact image that will be published"
                />
              ) : showPublished ? (
                <img
                  className="published-preview-image"
                  src={`/p/${session.pageId}/preview.png?v=${state.value.revision}`}
                  alt="Currently published preview"
                />
              ) : (
                <div className="preview-card-draft">
                  <span className="preview-card-brand">{PRODUCT_NAME}</span>
                  {state.draft.visual !== "text" && (
                    <Image size={32} strokeWidth={1.25} aria-hidden="true" />
                  )}
                  <strong>{state.draft.title || "Your Page title"}</strong>
                  <p>{state.draft.description || "Description"}</p>
                </div>
              )}
              <figcaption>
                <span>
                  {state.prepared ? (
                    <>
                      <Check size={13} /> Ready to publish
                    </>
                  ) : showPublished ? (
                    <>
                      <Globe size={13} /> Currently published
                    </>
                  ) : (
                    "Draft"
                  )}
                </span>
                {showPublished ? (
                  <a
                    target="_blank"
                    rel="noreferrer"
                    href={`/p/${session.pageId}/preview.png?v=${state.value.revision}`}
                    aria-label="Open published image"
                  >
                    <ArrowUpRight size={15} />
                  </a>
                ) : (
                  <span>1200 × 630</span>
                )}
              </figcaption>
            </figure>
            <div className="preview-field">
              <div className="preview-field-label">
                <label htmlFor={`${id}-name`}>Preview title</label>
                <span>{state.draft.title.length}/160</span>
              </div>
              <input
                id={`${id}-name`}
                value={state.draft.title}
                maxLength={160}
                disabled={!ready}
                onChange={(event) => edit({ title: event.target.value })}
              />
            </div>
            <div className="preview-field">
              <div className="preview-field-label">
                <label htmlFor={`${id}-description`}>Description</label>
                <span>Optional</span>
              </div>
              <textarea
                id={`${id}-description`}
                value={state.draft.description}
                maxLength={400}
                rows={2}
                placeholder="Add a description…"
                disabled={!ready}
                onChange={(event) => edit({ description: event.target.value })}
              />
            </div>
            <div className="preview-field">
              <label htmlFor={`${id}-visual`}>Image source</label>
              <select
                id={`${id}-visual`}
                aria-label="Preview image"
                value={state.draft.visual}
                disabled={!ready}
                onChange={(event) => edit({ visual: event.target.value })}
              >
                <option value="text">Title and description card</option>
                {visuals.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
                <option value="upload">Upload a cover</option>
              </select>
              {state.draft.visual === "upload" && (
                <label className="preview-upload">
                  <Upload size={17} />
                  <span>
                    {state.draft.file?.name || "Choose a cover image"}
                    <small>PNG, JPEG or WebP</small>
                  </span>
                  <input
                    aria-label="Cover image"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={!ready}
                    onChange={(event) =>
                      dispatch({ type: "choose_cover", file: event.target.files?.[0] })
                    }
                  />
                </label>
              )}
            </div>
          </div>
          <footer className="published-preview-footer">
            {state.error && (
              <p role="alert">
                {state.error}{" "}
                <button
                  className="preview-text-button"
                  type="button"
                  onClick={() => dispatch({ type: "reload" })}
                >
                  Reload settings
                </button>
              </p>
            )}
            {busy && (
              <p role="status">
                {state.name === "rendering" ? "Preparing image…" : "Saving preview…"}
              </p>
            )}
            {state.message && (
              <p className="preview-success" role="status">
                <Check size={14} /> {state.message}
              </p>
            )}
            <div className="published-preview-actions">
              {published && (
                <button
                  className="preview-remove"
                  type="button"
                  disabled={!ready}
                  onClick={() => dispatch({ type: "unpublish", nonce: crypto.randomUUID() })}
                >
                  Remove preview
                </button>
              )}
              <div className="preview-primary-actions">
                <button
                  className={state.prepared ? "preview-secondary" : "preview-primary"}
                  type="button"
                  disabled={
                    !ready ||
                    !state.draft.title.trim() ||
                    (state.draft.visual === "upload" && !state.draft.file)
                  }
                  onClick={() => dispatch({ type: "prepare" })}
                >
                  Prepare preview
                </button>
                {state.prepared && (
                  <button
                    className="preview-primary"
                    type="button"
                    disabled={!ready || !state.draft.title.trim()}
                    onClick={() => dispatch({ type: "publish", nonce: crypto.randomUUID() })}
                  >
                    {published ? "Update public preview" : "Publish preview"}
                  </button>
                )}
              </div>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
