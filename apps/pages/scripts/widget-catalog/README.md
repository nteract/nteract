# Try a Page with shared widget imports

The local catalog supplies React, React DOM, D3 and Observable Plot as one
immutable ESM build. Each widget has its own iframe and React root. The Page
can pin additional JavaScript sources under import names. This demo's two
widgets import the same ChoiceGroup from [activity-controls.mjs](activity-controls.mjs).
Its buttons use the output frame's theme.

Run the Pages setup and build from `apps/pages`. Start the catalog first, then
start celld in a second terminal from the same directory.

```sh
node scripts/widget-catalog/serve.mjs
PAGES_E2E_ONLY=true PAGES_PORT=9916 PAGES_OUTPUT_FRAME_URL=http://127.0.0.1:9446/frame/v2/ npm run dev
```

Run `node scripts/widget-catalog/demo.mjs` to create a Page with illustrative
counts and exercise both widgets. Open Widget imports in Sources to see the
catalog, Page module pins, and the views using them.

An agent can discover the catalog through `read_page.widget_imports`. Upload a
component as a regular JavaScript source, then send this single operation to
`edit_page` (omit `modules` to select just the standard libraries).

```json
{
  "op": "set_widget_imports",
  "catalog": "standard",
  "source_revision": null,
  "modules": [{"name": "activity-controls", "source_id": "controls", "revision": "1"}]
}
```

The host records the current catalog digest and the component's immutable asset
in the Page's widget-imports source. A later component edit has no effect on
widgets until the declaration changes. To replace it, pass its observed
source_revision and the full module list. The frame installs one import map
with catalog URLs and private module blob URLs before importing the widget.
Keep `.output-dist/catalog/<sha256>/` for existing Pages. Restart local celld
after building a new catalog to make that revision selectable.
