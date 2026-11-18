# Try a Page with shared widget imports

This local celld experiment treats the binary source named `widget-imports` as
a declaration for every anywidget on the Page. Its asset ID is the SHA-256 of
the catalog manifest. The output server builds the actual nteract ToggleGroup,
ToggleGroupItem and Separator components, their utility CSS, React, D3 and Plot.
All modules for one revision use one split ESM build. Each widget has its own
iframe and React root. The browser can cache the same module URLs across widgets.

With the root pnpm dependencies installed, run the Pages setup and build from
`apps/pages`. Start these two commands in separate terminals there.

```sh
node scripts/widget-catalog/serve.mjs
PAGES_E2E_ONLY=true PAGES_PORT=9916 PAGES_OUTPUT_FRAME_URL=http://127.0.0.1:9446/frame/v2/ npm run dev
```

Run `node scripts/widget-catalog/demo.mjs` from the same directory. It signs in
using the local test OAuth client, creates one Page with synthetic activity,
and prints its URL. Try both toggles. Open the Widget imports source beneath
the title to see the imports, catalog fingerprint and connections to both views.

To author another Page, fetch the manifest bytes from
`http://127.0.0.1:9446/catalog.json`, upload them as `application/octet-stream`
through `create_page_asset_upload`, then use `set_source` with
`source_id: "widget-imports"` and the returned asset ID. A subsequent update to
this source moves all widgets on the Page to that catalog. Existing revisions
are served from `.output-dist/catalog/<sha256>/` in this worktree. Keep that
directory when trying a new build. Uploaded widget modules contain ordinary
ES imports, as in [activity.mjs](activity.mjs) and [roles.mjs](roles.mjs).
