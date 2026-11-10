/** Smoke fixtures are disposable. delete_page only moves a Page to Trash, so
 * cleanup also deletes it permanently; otherwise repeated runs fill the
 * account's Trash and keep fixture documents readable by their owner.
 *
 * `invoke(operation, args)` returns a successful result body and throws on
 * failure. `authority()` returns fresh catalog `retry_token` and
 * `idempotency_key` values, or an empty object for legacy keys.
 */
export async function purgeTrashedFixture(invoke, pageId, authority = async () => ({})) {
  const preview = await invoke("purge_page", { page_id: pageId, action: "preview" });
  return invoke("purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.preview_token,
    ...(await authority()),
  });
}
