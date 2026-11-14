import React, { useEffect, useId, useMemo, useReducer, useState } from "react";
import { defer } from "rxjs";
import { request } from "./request.mjs";
import { uploadPageImage } from "./image-upload.mjs";
import { previewEditorTransition } from "./published-preview-state.mjs";
import { previewVisuals, renderPublishedPreview } from "./published-preview-image.mjs";
import "./published-preview.css";

function PreparedImage({ blob }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url ? (
    <img className="published-preview-image" src={url} alt="Exact image that will be published" />
  ) : null;
}

export function PublishedPreview({ session }) {
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
      if (state.name === "rendering")
        return {
          type: "prepared",
          prepared: await renderPublishedPreview(state.draft, visuals, signal),
        };
      if (state.name === "uploading")
        return {
          type: "uploaded",
          asset: await uploadPageImage(session.pageId, state.prepared, signal),
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
  return (
    <section className="published-preview" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Link preview</h3>
      <p>
        Publish a title, description, and image anyone with the link can see. Page access stays
        restricted.
      </p>
      {state.name === "loading" ? (
        <p role="status">Loading preview settings…</p>
      ) : (
        <>
          <label htmlFor={`${id}-name`}>Preview title</label>
          <input
            id={`${id}-name`}
            value={state.draft.title}
            maxLength={160}
            disabled={!ready}
            onChange={(event) => edit({ title: event.target.value })}
          />
          <label htmlFor={`${id}-description`}>Description</label>
          <textarea
            id={`${id}-description`}
            value={state.draft.description}
            maxLength={400}
            rows={3}
            disabled={!ready}
            onChange={(event) => edit({ description: event.target.value })}
          />
          <label htmlFor={`${id}-visual`}>Preview image</label>
          <select
            id={`${id}-visual`}
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
            <input
              aria-label="Cover image"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={!ready}
              onChange={(event) => edit({ file: event.target.files?.[0] })}
            />
          )}
          {state.prepared && <PreparedImage blob={state.prepared} />}
          <p className="published-preview-note">
            This publishes a snapshot. Later Page edits stay private until you update the preview.
            Other services may keep copies after you remove it.
          </p>
          <div className="published-preview-actions">
            <button
              type="button"
              disabled={!ready || !state.draft.title.trim()}
              onClick={() => dispatch({ type: "prepare" })}
            >
              Prepare preview
            </button>
            <button
              type="button"
              disabled={!ready || !state.prepared}
              onClick={() => dispatch({ type: "publish", nonce: crypto.randomUUID() })}
            >
              {state.value?.snapshot ? "Update public preview" : "Publish preview"}
            </button>
            {state.value?.snapshot && (
              <button
                type="button"
                disabled={!ready}
                onClick={() => dispatch({ type: "unpublish", nonce: crypto.randomUUID() })}
              >
                Remove preview
              </button>
            )}
          </div>
          {state.value?.snapshot && (
            <p>
              Published {new Date(state.value.snapshot.published_at).toLocaleString()}.{" "}
              <a target="_blank" rel="noreferrer" href={`/p/${session.pageId}/preview.json`}>
                View published details
              </a>
            </p>
          )}
        </>
      )}
      {!["ready", "failed", "loading"].includes(state.name) && (
        <p role="status">{state.name === "rendering" ? "Preparing image…" : "Saving preview…"}</p>
      )}
      {state.error && (
        <p role="alert">
          {state.error}{" "}
          <button type="button" onClick={() => dispatch({ type: "reload" })}>
            Reload settings
          </button>
        </p>
      )}
      {state.message && <p role="status">{state.message}</p>}
    </section>
  );
}
