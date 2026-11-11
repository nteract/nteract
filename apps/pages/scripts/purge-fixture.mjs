/** Smoke fixtures are disposable. delete_page only moves a Page to Trash, so
 * cleanup also deletes it permanently; otherwise repeated runs fill the
 * account's Trash and keep fixture documents readable by their owner.
 *
 * `invoke(operation, args)` returns a successful result body and throws on
 * failure. `authority()` returns the confirm's arguments beyond the preview:
 * its `nonce`.
 */
export async function purgeTrashedFixture(
  invoke,
  pageId,
  authority = async () => ({ nonce: crypto.randomUUID() }),
) {
  const preview = await invoke("purge_page", { page_id: pageId, action: "preview" });
  return invoke("purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.preview_token,
    ...(await authority()),
  });
}
