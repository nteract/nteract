# Share a component between module views

Two independent React roots import the same ChoiceGroup from [activity-controls.mjs](activity-controls.mjs). Each view imports its own entry, the shared component and the same synthetic counts. React, D3, Plot and the Sift Parquet reader come from the library catalog the Page host's build carries, at the revision saved on the view.

Run the Pages setup and build from `apps/pages`. Start the local output host first, then start celld in a second terminal from the same directory. The output host serves the frame with a CSP that admits the local Pages origin, which serves the libraries at `/catalog/<revision>/`.

```sh
PAGES_PORT=9916 node scripts/widget-catalog/serve.mjs
PAGES_E2E_ONLY=true PAGES_PORT=9916 PAGES_OUTPUT_FRAME_URL=http://127.0.0.1:9446/frame/v2/ npm run dev
```

Run `node scripts/widget-catalog/demo.mjs` to create a Page and exercise both controls. Open **Activity controls** in Sources to see the two views that import it. **Standard libraries** shows their catalog revision.

A new JavaScript view uses the following `edit_page` operation once its sources exist.

```json
{
  "op": "set_view",
  "view_id": "activity",
  "view_revision": null,
  "view_type": "module",
  "title": "Daily activity",
  "module": {"source_id": "activity"},
  "data": {"activity": {"source_id": "example-counts"}},
  "imports": {"activity-controls": {"source_id": "controls"}}
}
```

Both views follow the controls source in this example. Updating that source refreshes both views. Add `revision` to a binding to keep that view on a specific version. Each iframe installs its own import map. The `insert_node` operation places the saved view in the document.
