# Pages behavior reference

Behavior of the Page host, viewer and agent tools in this source revision.
Read the code and its colocated tests for exact contracts; this file maps them.
The protected deployed service may run an earlier revision.

The native path uses Wordgard for both reads and writes; ProseMirror is absent
from the production graph. [DIRECTION.md](DIRECTION.md#what-changes-from-today)
lists what the next format and tool surface change.

## Published link previews

The Page owner can open **Share → Link preview**, supply a title (160
characters) and description (400 characters), then prepare and explicitly
publish a raster image. The default is a 1200×630 text card. The owner can
instead choose a rendered image, chart or Mermaid diagram from the open Page,
or upload a cover. The browser shows the exact bytes before uploading them;
the host validates the raster and publishes only that Page-local asset.

When publishing an uploaded cover, its original bytes also enter the existing
private Page asset storage. The publication record retains the cover asset ID
and filename for owner settings; public metadata and image routes expose only
the composed card. Reopening the editor restores that cover so text edits can
redraw it. Removing the cover clears the reference on the next publication.
Render errors leave the draft editable and offer a retry; refreshing settings
after a network error preserves local edits while reading the current revision.

This does not grant document access. The separate `host/published-preview`
record is owned by the Page host, outside Automerge. Publishing and removal
require the owner and write credentials, an observed publication revision and
a nonce. The last receipt makes a lost-response retry idempotent; stale writes
are refused. Edits never update a published snapshot automatically. Trashing
and restoring a Page invalidates the snapshot's lifecycle fence, so restore
does not silently republish it.

`GET /api/link-preview?page=<id>` reads owner settings; `POST` publishes or
removes them. Anonymous readers of `/p/<id>` get OG metadata from the approved
snapshot, or generic product metadata when no preview is published. The
public `/p/<id>/preview.json` and `/p/<id>/preview.png?v=<revision>` routes
serve only the current publication and use `no-store`. A removed or superseded
image URL returns 404. Other services may retain copies they already fetched.
Private `meta.json`, `card.json`, assets and document routes retain their access
checks. There is no public Page mode or model-provider dependency.

The optional single-workspace Slack adapter (`worker/slack-previews.mjs`)
turns the same public snapshot into a Content Item Work Object, including its
image and a full-size image preview. Both unfurls and detail panes currently
show only published information. They never infer Pages access from a Slack
user or channel. Private live details require a future account-linking flow;
today users open Pages and use its normal sign-in. See
[Slack setup](DEPLOYMENT.md#optional-slack-work-objects).

## Editor and content features

A Page holds its title, blocks keyed by ID with a fractional `position`, and
rich text in Automerge. Comments live in a second document
([Comments document](#comments-document)). Wordgard is the only editor.

Each block has its own continuous editor. Moves update `position` without
recreating the block or its text object, so comment and selection anchors hold.
Equal positions tie-break on block ID. Selections don't cross blocks. When a
block ends in a code block, table, unknown block or image, ArrowDown on its last
line, Mod-Enter, or a click below it adds an empty paragraph. That paragraph is
an ordinary edit, so opening a Page writes nothing.

Agent Markdown writes (create, insert or replace Markdown, comments with
`body_format: "markdown"`) refuse math and HTML other than highlight tags with
`400 unsupported_markdown` and `unsupported: { construct, line, column, excerpt }`,
before anything is written. Export escapes literal `$` and `<`, so every read is
writable. A node from a newer build opens read-only through its feature stamp;
reads project `[Unsupported node: <type>]`.

Ordered lists are stored without a start number, so every list starts at 1.
A Markdown write whose list starts elsewhere keeps the items and renumbers
them. The write's receipt carries a `list_numbers_reset` warning
([list-start-warning.mjs](model/list-start-warning.mjs)): each such list's
`start` and the start of its first item's text (`first_item`), capped at 32
lists (`lists_truncated`). It covers `create_page`, `insert_markdown` and
`replace_block_markdown`. The editor resets a typed start to 1 too
(`wordgardListStarts`), with no warning.

The interface keeps navigation and account actions outside the document, with
contextual formatting, a searchable Pages list, and System/Light/Dark appearance
using nteract's shared tokens. Theme preferences are browser-local. **Copy as
Markdown** in Share exports the title and content, including private image
references; it does not publish the Page or change asset access. It runs the
Markdown projection when clicked (`session.markdownProjection()`). Drawing the
Page never does: `session.snapshot()` carries each block's id and order, and
the editor decodes the block's spans itself. A throw while drawing one block
shows a notice in its place (`viewer/BlockBoundary.jsx`); a throw anywhere
else replaces the screen with a Reload notice and leaves the Page unchanged.

- **Comments:** select a passage and choose Comment, or press Cmd/Ctrl+Alt+M.
  Highlighted passages and thread quotes navigate between text and discussion.
  Draft anchors capture native object identity and text cursors; deleted or
  replaced passages reject submission rather than moving a comment elsewhere.
  Comments are the same rich text as a Page body: every message is stored as
  the editor's spans, the form Wordgard's `encode` writes, through the same
  path Page bodies use. The browser composer is a Wordgard editor that sends its
  spans as they are, with no Markdown in between; drafts keep their spans until
  Send and survive responsive rail/sheet changes; changing Pages clears local
  drafts. Expand the sidebar for wider discussions. Agent comments opt in with
  `body_format: "markdown"` on `manage_page_comment`; rich comment reads return
  Markdown computed from the spans and the same format marker. Plain input
  (`body_format: "plain"`, the default for a new message) is stored as spans
  with no marks, each newline a hard break, and records `bodyFormat: "plain"`,
  so reads return the text literally without a format marker, as plain reads
  always have. Omitting the format when editing retains the message's current
  kind. Thread/message IDs and passage anchors stay unchanged. A message
  (`pages.comments` format 2) holds `richText`, `author`, `createdAt`,
  `deletedAt` and, for plain input, `bodyFormat`. Its rich text is in the same
  form as a block's: every node opens with its marker. No Markdown copy and no
  per-message `format` field is stored, and the comments document's admission
  refuses a message with any other field. If native content
  cannot be decoded, reads return its bare text with
  `content_error: "rich_text_unavailable"` rather than failing the entire Page.
  A message holds at most 16,000 text characters (block markers don't count,
  so the span form never changes a message's length) and 64 KiB of stored
  spans. Formatting-only changes appear in `read_page_changes`.
- **Highlights:** the formatting toolbar's highlighter offers the four palette
  colors and Remove; Cmd/Ctrl+Shift+H toggles yellow. A highlight is a text mark
  (`highlight`), so it syncs, merges, and follows edit permission like bold.
  Palette names resolve to theme tokens; agents can also set `#rrggbb`. Markdown
  projects highlights as `<mark data-color="…">…</mark>`. Comment anchors keep
  their own tint and underline; where they overlap a highlight, both tints show.
- **Typing shortcuts:** `*x*` and `_x_` italicize, `**x**` bolds, `~~x~~`
  strikes through when the closing delimiter is typed. A delimiter touching a
  letter or digit (`snake_case_name`, `2*3*4`), an escaped one, and one inside
  code stay literal; undo restores the typed delimiters. `---` alone in a
  paragraph inserts a horizontal rule. Cmd/Ctrl+Shift+X toggles strikethrough.
- **Code blocks:** Tab indents and Shift+Tab removes one level, for the caret's
  line or every selected line. One level is four spaces in Python and Rust, two
  elsewhere, and a tab in a block whose lines already start with tabs. Enter
  keeps the indentation of the line it leaves; three Enters, or Mod-Enter, leave
  the block. Outside a code block Tab moves focus as usual. A word in code is an
  identifier: letters, digits and underscores, plus `$` in JavaScript and
  TypeScript and `-` in CSS. A double-click selects it whole, and Wordgard's
  word motion and word deletion move over it whole. Brackets and quotes close
  themselves as in CodeMirror: typing the inserted closer moves over it,
  Backspace inside an empty pair deletes both, and a selection gets wrapped.
  Cmd/Ctrl+/ comments or uncomments the touched lines with the language's line
  comment, or one block comment in CSS and HTML; JSON and blocks with no language
  have none. Both read the highlighter's language data. Code text carries no
  marks, so a selection inside one code block gets a toolbar with the text style
  and Comment only, placed outside the block.
- **Mark registry:** [`model/marks.json`](model/marks.json) lists every inline
  mark with its value shape, expand rule, and Markdown projection. Validation,
  the Wordgard binding, Markdown import/export, and the MCP `format_match`
  schema read it. Readers keep marks they don't know: they render as
  plain text and survive edits. Agents edit existing text through
  `replace_match`, `format_match` and `set_node`, which work on native spans
  and block markers; Markdown is for reading, for writing whole blocks, and
  for `replacement_markdown`'s inline formatting.
- **Agent guidance:** [`model/rich-content-guide.mjs`](model/rich-content-guide.mjs)
  writes the rich-content paragraph in the MCP server instructions, the
  `markdown` parameter description and `/llms.txt` from `marks.json`,
  `features.json` and [`shared/code-languages.mjs`](shared/code-languages.mjs).
  Importing it throws when a mark or feature block has no agent syntax, so a
  new one can't reach people without reaching agents.
- **Schema features:** every mark and block type that existed when Page10
  launched is baseline. A later one names a feature id: a mark in
  `marks.json`, a block type in [`model/features.json`](model/features.json).
  A Page that uses one carries a stamp at its document root,
  `schema: { features: [...] }`, sorted and never shrinking. Unstamped Pages
  use only the baseline, so no Page10 document needs a migration.
  [`model/schema-features.mjs`](model/schema-features.mjs) holds the rules:

  | Who | Rule |
  | --- | --- |
  | Writer (host tools, import, Wordgard binding, comments) | Adds a feature's id in the same Automerge change that first writes content needing it. Never removes an id. |
  | Viewer | `unsupported = stamp − BUILD_FEATURES`. Non-empty opens the Page read-only with a Reload notice; sync continues. The notice's Reload writes any edits the host refused to this browser's store, then reloads without the host's receipt; if that write fails, it blocks and keeps the edits in the tab. |
  | Host, tools | Refuses tool writes and draft registration with `409 unsupported_schema_feature` and `unsupported_features`. Replays of recorded receipts still answer. |
  | Host, sync | The viewer declares its build's features on `/api/sync` (`schema_features`; none means the baseline). SyncHost refuses a change from that connection while its build lacks a stamped id, and the matching `/api/saved` receipt answers `409 schema_unsupported`, which the viewer shows as the read-only notice. |
  | Agents | `read_page` returns `schema_features`, an empty array when unstamped. |

  Concurrent first stamps can conflict on `schema`; readers union every
  conflicting value and the next writer folds them into the visible list. The
  stamp is per document; the minimum viewer protocol in [Build updates](#build-updates)
  is per build. A declaration is the client's own claim: the gate stops
  stale clients from writing what they can't express, not hostile ones, whose
  edits write authority already bounds.
- **Links:** click for Open, Edit, and Remove; Cmd/Ctrl-click opens directly and
  Cmd/Ctrl+K edits. Incoming edits update or dismiss the link control, and URL
  policy applies both to stored content and navigation.
- **Heading links:** every heading has an anchor, a slug of its visible text
  (lowercase, punctuation and symbols dropped, whitespace runs as one hyphen,
  letters and digits of every script kept, at most 100 code points), numbered
  `-1`, `-2`, … for repeats in document order; a heading with no letters or
  digits is `section`. [`model/heading-anchors.mjs`](model/heading-anchors.mjs)
  computes them from the stored spans each time the document is read. Nothing
  stores them, so no schema feature or migration is involved, and renaming a
  heading changes its anchor. The viewer and `read_page` (`anchor` on an
  outline heading entry) read the same function. A link to `#anchor` or
  `/p/<page_id>#anchor` is an ordinary link mark. The `#` beside a heading
  under the pointer copies its link. A fragment in the address scrolls to its
  heading once the Page has synced and drawn it, waiting up to 15 seconds, and
  scrolls again while late layout above it settles; the reader scrolling,
  typing or clicking first cancels it, from page load on, including while the
  loading preview shows. Each history entry records its scroll position, and
  Back and Forward return to it once the Page has drawn, or to the entry's
  heading when it has none. A reload goes to the heading, and the browser's
  own restoration stays on for other screens
  ([`viewer/HeadingAnchors.jsx`](viewer/HeadingAnchors.jsx),
  [`viewer/heading-scroll.mjs`](viewer/heading-scroll.mjs),
  [`viewer/heading-links.mjs`](viewer/heading-links.mjs)). Links in a Page to
  this app's Pages and Projects open in place, without a reload or new tab;
  modified clicks still open a tab. The editor's DOM gets no ids: a heading is
  found by its block and its ordinal among the block's headings. Touch screens
  have no hover, so copying a heading's link there needs the address bar.
- **Links between Pages and to Projects:** a link stores only its href; the
  target's title is never written into the document. One test
  ([`shared/page-links.mjs`](shared/page-links.mjs)) decides which links go to
  this deployment's Pages and Projects: `safeUrl`, then exactly this origin
  once resolved (so `HTTPS://Host:443/p/<id>` and a relative `/p/<id>` count,
  and a look-alike host, user info, a trailing dot or another deployment
  don't), then `readPageRoute` reads a Page (`/p/<uuid>`, with or without a
  slug after it) or a Project
  (`/project/<prj_id>`, or the older `/s/<id>`, with a `prj_` or older `sp_`
  ID). `linkTarget` names either kind, and `linkedTarget` drops links to
  what's open: the open Page (its links are section links) and, on a
  Project's route, the Project itself, whose content is open; a Project link
  inside an ordinary Page of that Project still counts. In-place navigation
  and the glyphs use the same test, so they can't disagree. A link to
  another Page draws with the `page-link` class, `data-page-id` and a small
  muted Page glyph (lucide's FileText) after its text, and a link to a
  Project with `project-link`, `data-project-id` and a Project glyph
  (lucide's Boxes, as the library, picker and Project chip draw Projects), in
  Page blocks, the loading preview and comments
  ([`viewer/link-destination.mjs`](viewer/link-destination.mjs),
  [`viewer/page-link-shape.mjs`](viewer/page-link-shape.mjs)). The open Page
  and Project reach comments and Page blocks through `CurrentPage` and
  `CurrentProject` ([`viewer/current-page.mjs`](viewer/current-page.mjs)).
  CSS draws the glyphs (`::after` with a mask and empty alternative text,
  flipped for right-to-left text), so no widget enters the editor: the caret,
  selection, typing at the link's end and copying behave as for any link. A
  link draws as one element however its text is formatted, so it has one
  glyph: `PagesLink` has Wordgard's link rank and nests outside bold,
  italic, strike, code and highlight (`model/wordgard-doc.mjs`; stored spans
  keep their mark order), and the loading preview joins the fragments the
  host renders (`PagePreview.jsx` `joinLinks`).
  Resting the pointer on one for 300 ms opens a hover card
  ([`viewer/PageLinkCard.jsx`](viewer/PageLinkCard.jsx),
  [`viewer/page-link-card.mjs`](viewer/page-link-card.mjs)). For a Page it
  shows the title the reader's own session resolves (two lines at most,
  direction isolated), when the Page was edited, and its first screen as the
  library grid draws it. For a Project it shows a small "Project" label with
  its icon, the title, the description (at most three lines, omitted when
  empty) and the first screen of its content document. Then Open (in place)
  and Open in new tab; a link in a comment offers only Open in new tab, as
  comment links always open, so a draft is never navigated away from. A
  target the reader can't open shows a lock and "Page unavailable" or
  "Project unavailable", nothing else: the same answer stands for a host
  that didn't respond, so it gives no reason. Loading shows a skeleton, and
  a failure "Couldn't load a preview". The pointer has 200 ms to cross from
  the link into the card. Using an action closes it, and so do a keypress
  (for a card the pointer opened) and the link menu opening. It never opens
  while the link menu is open, while a mouse button is down, for touch or
  pen input, where the device can't hover, or for a link inside a card.
  Keyboard focus opens the card at once for links that take focus: in
  read-only blocks, comments and the loading preview. In an editable block
  focus stays on the editor, so a caret entering a link opens nothing. From a
  focused link, Tab moves into the card's actions, Shift-Tab from the first
  returns to the link, and Tab past the last closes the card and moves on.
  The link is `aria-describedby` the card while it shows, and a polite live
  region announces the answer once it loads: a Page's title or "Page
  unavailable", "Project: <title>" or "Project unavailable". Escape closes
  the card, marked handled so a comments panel doesn't also back out, and
  returns focus to the link, or to the editor (keeping its selection) when
  the link is editable content. Titles and cards live in one in-memory store
  per tab ([`viewer/page-refs.mjs`](viewer/page-refs.mjs)): each `(account,
  kind, id, file)` ref, so a Page and a Project never share one, is fresh
  for 60 s, or 15 s when unavailable, a failure retries after a doubling
  backoff from 2 s, concurrent asks share a request, and at most 6 run at
  once, of both kinds. Another account, sign-out or any 401 drops them all.
  Refs load when a card opens or a chit draws; a mounted chit asks again
  once its answer is stale, dropped, or failed past its backoff, so a rename
  shows within a minute. The store takes a non-urgent
  ask so a viewport observer can drive it later. The routes are under
  [Link previews](#link-previews).
- **Bare links and chits:** a plain-text paste of exactly one absolute
  http(s) URL, into a Page block or a comment, inserts a bare link: the URL
  as text with a link mark whose href is that text and no title
  ([`viewer/bare-links.mjs`](viewer/bare-links.mjs)). Paste as plain text,
  a paste into code or an existing link, and anything else on the clipboard
  stay text; HTML takes the HTML path. Undo first takes the link off, then
  the text. Markdown reads a bare link as an autolink, `<url>`, and agents are
  told to write Page and Project links that way (`pageLinks` in
  [`model/rich-content-guide.mjs`](model/rich-content-guide.mjs)). A bare
  link that `linkedTarget` accepts draws as a chit: the glyph, then the
  title this reader's session resolves, "Page unavailable" or "Project
  unavailable" ([`viewer/page-chits.mjs`](viewer/page-chits.mjs)). Nothing is
  stored: a range wrapper hides the URL and a point widget draws the chit,
  an `<a>` with the link's class and data attribute, so a click opens the
  link menu in an editable block and the hover card treats it like any other
  Page or Project link. In a focused editable block, a local caret inside
  the URL or at either edge, or a selection end strictly inside it, shows the
  URL as ordinary text; peers' edits and read-only blocks never do. The
  loading preview draws bare links as links, not chits.
- **Code and diagrams:** three backticks on an empty paragraph followed by Enter
  or Space creates code; a language can follow the backticks. Mermaid renders
  through nteract's Pele renderer and SVG sanitizer. Compact Edit diagram,
  Preview, and Copy diagram code controls switch the local view. Maximize
  opens a copy of the rendered SVG in a full-viewport dialog that fits it to
  the screen; wheel, pinch, drag, the zoom buttons and Fit move it, and Escape
  or Close returns focus to Maximize. The dialog never edits. Pele's inline
  zoom controls get a gutter beside a shrunk diagram. Source and
  language are shared content; rendered SVG is not stored. Cmd/Ctrl+Enter
  continues in a paragraph. Pages does not execute code.
- **Dataframes:** a `dataframe` block marker with no text. Its attrs are
  either `src` (a Page asset path) or `binding` (`{source_id, revision?}`),
  plus `media_type` and an optional `title`
  ([`shared/dataset-assets.mjs`](shared/dataset-assets.mjs)). The viewer picks
  a renderer by media type
  ([`viewer/wordgard-dataframes.mjs`](viewer/wordgard-dataframes.mjs));
  `application/vnd.apache.parquet` renders as a Sift table
  ([`viewer/sift-table.jsx`](viewer/sift-table.jsx)), loaded with its
  stylesheet and WASM only when a Page shows one, and only once that table
  comes within 600 px of the viewport; until then it says it loads when you
  scroll to it, in a status line laid over the canvas so nothing moves when the
  table draws. Printing starts every table loading, but loads are async, so a
  print made at once still shows that text for tables not yet drawn. Enter on a
  selected table focuses its grid, and does nothing before the grid loads. A loaded table stays
  loaded offscreen, keeping the reader's sort and filters. The lifecycle is
  [`viewer/dataframe-table-machine.mjs`](viewer/dataframe-table-machine.mjs). Dropping or pasting a
  `.parquet` file uploads it and inserts the node at the cursor, undoably.
  Agents use `edit_page` `insert_node`. A dataframe has no Markdown syntax:
  it reads as `[Dataframe: <title>](<src>)` on its own line, and Markdown
  never creates one. In a block that holds one, `replace_block_markdown` turns
  that exact line back into the original node, unknown attrs included, where
  the node is stored: the top level, or inside the same kind of container. It refuses
  (`markdownless_node`) a rewrite that drops or edits the line, moves it into or
  out of a container or heading, repeats it beyond the block's matching nodes,
  or adds a line reading like a dataframe the block doesn't hold. Moving the
  line among its neighbours keeps the attrs and writes a new marker. It's gated by the `dataframe` schema
  feature. Decode is lenient: a later build's media type or attr under the
  same feature still decodes, draws "This build can't show…", and writes back
  unchanged; writers (`insert_node`, upload) check strictly. Copy writes a
  `figure[data-pages-dataframe]` with the attrs as JSON, and paste reads it
  back when its `src` is on the same Page.

  Clipboard HTML is untrusted, so a table's data moves between Pages only
  when this browser copied it. A copy or cut holding this Page's tables
  writes a copy record to this origin's `localStorage`
  ([`viewer/copy-registry.mjs`](viewer/copy-registry.mjs)): a random 128-bit
  id, the Page, its title and the asset ids. The clipboard HTML gets one empty hidden
  `span[data-pages-copy]` holding `{"v": 1, "id": …}`; other apps paste
  nothing from it, and Pages strips it before reading a paste. The registry
  keeps the 20 newest copies, each for one hour: long enough to paste in
  another tab, and short, because the id leaves the browser with the
  clipboard. Without `localStorage` nothing is recorded and nothing copies.

  A paste or drop reading HTML that holds tables from another Page looks up
  the clipboard's copy id. A table copies only when the record exists, names
  the Page in the table's `src` and lists its asset; no other field of the
  clipboard element counts. A record shows that this browser copied the
  table, not that the person means to move its data here: another site that
  saw the clipboard can hand the id back inside its own content. So the
  paste is held while the Page asks, in the paste's status row, whether to
  bring the data for the tables from the Page the record names, by the
  record's title, never the clipboard's. Bring data starts the copies;
  Paste titles only lands the paste now with those tables as titles; Cancel
  drops it. Nothing is requested before Bring data. An answer counts only for
  the question it was shown with, so a late answer can't start another
  paste's copies; answering from the keyboard puts focus back in the Page. The paste then waits
  while the host copies each dataset onto this Page (`POST /api/pages/:pageId/assets/:sha256` with
  `{"from_page_id": …}`), at most 8 tables a paste and 2 at a time, and
  lands with each `src` on this Page, replacing the selection as any paste
  does, with the caret after it. Whether it landed is the transaction's own
  answer: the Page reports it refused only when the binding refused it. A table that didn't copy (not this browser's copy, past the limit,
  or refused by the host) lands as its title, and the Page says why. In a
  code block and for paste-as-plain-text, Wordgard reads the clipboard's
  text and nothing is held. A paste made while another is held takes the
  editor's own path: its tables from other Pages land as titles, with no
  message of its own. The lifecycle is
  [`viewer/dataframe-copy-machine.mjs`](viewer/dataframe-copy-machine.mjs).
  The node never names another Page, and the table fetch refuses a `src` on
  another Page. A dataframe whose attrs this build can't read
  decodes as an unknown node (see above), and a Markdown rewrite of its block
  is refused. Each block editor also sits in an error boundary
  (`viewer/BlockBoundary.jsx`), so any other failure to draw one block can't
  unmount the viewer. Sorting, filtering and
  scrolling stay in each reader's view. A shared view (filters, sort, column
  choices) is not stored yet; it belongs in its own Automerge document keyed
  by the node, like the comments document, so view edits never touch Page
  content or its history.
- **Tables:** native row/cell markers live in the same rich-text field as prose.
  Insert table chooses dimensions; Table options changes rows and columns. Tab
  moves between cells and appends a row at the end. The first row is the header.
  Column resizing/moving and merged cells are not implemented.
- **Task lists:** use Task list or type `- [ ] ` / `- [x] `. Enter creates an
  unchecked item; an empty item returns to prose. Native list-item markers store
  checked state independently of the text, so checkbox and text edits can merge.
  Markdown preserves nested tasks. Read-only Pages disable checkbox changes.
## Opening, recovery, and ownership

Canonical links are `/p/<page_id>`, with `#anchor` for a heading (see Heading
links); browser Back/Forward restores the corresponding Page and heading, and
legacy query links normalize, keeping the fragment. Direct links work independently of the
catalog but never bypass Page permissions.

A link may carry a slug after the id, `/p/<page_id>/<slug>`, which reads as
the Page's title for people and link previews. It opens the same Page; the id
alone finds and authorizes it, so a stale or hand-typed slug still opens it.
The slug comes from the title (`pageTitleSlug`): accents come off ("Café"
gives `Cafe`), case stays as typed, every run of other characters becomes one
`-`, and it is cut at 80 characters on a `-` when one is near. A title with
no Latin letter or digit, an empty title and one that reads `view` give no
slug; nothing transliterates. A slug is 1 to 80 of
`A-Z a-z 0-9 _ -`, holds a letter or digit, and isn't `view` in any case
(`isPageSlug` in [shared/routes.mjs](shared/routes.mjs)); any other segment
after the id is not a Page route. The gateway serves such a path the app
shell with its `<title>` set to the slug's words (`-` and `_` become spaces,
runs collapse, the ends trim) beside the product name, and an `og:title` of
the words alone, HTML-escaped ([worker/page-shell.mjs](worker/page-shell.mjs)).
It looks nothing up, so the shell is the same bytes whether the Page exists or
the caller can read it, and it answers `Cache-Control: no-store` with no
ETag. A bare `/p/<page_id>` is served the plain shell, unchanged: the gateway
never looks up a title to redirect or to fill it in. A signed-in reader's tab
title is the Page's own.

Every link Pages hands out for a Page whose title it has carries the slug
(`pageLinkPath`, `pageUrl`): library and Project rows, breadcrumbs, the Browse
picker, Trash, and the `url` field of tool and REST results. A result built
without the title, such as an edit receipt, links to `/p/<page_id>`; nothing
reads a title just to build a link. MCP resource URIs stay `/p/<page_id>`, and
`resources/read` also takes the slugged form. While a Page is open, the address
follows its title in place, rename included (`history.replaceState` about a
second after the last title change, keeping the fragment and history state;
[viewer/address-slug.mjs](viewer/address-slug.mjs)). A title with no slug
leaves the address as it is. Both "Copy link" actions (the document menu and
Share) copy `copyLinkPath`: the current title's slug, else the slug the
address shows for that Page, else `/p/<page_id>`. The slug is the title, so
anyone who sees a link sees the title it had when the link was made. Worker
logs and usage records name a Page by id and never carry a request path.

Browser creation allocates the Page and history locally, persists them to
IndexedDB, and opens the editor while authenticated registration proceeds.
A registration whose Page another creation request already made is
`409 creation_conflict`; the browser reconciles the Page and registers under a
fresh nonce.
Account-scoped checkpoints let other tabs recover pending work; each tab has its
own native signing identity/database, protected by Web Locks. Checkpoints merge
Automerge history, and local deletion tombstones prevent stale tabs from reviving
removed entries. Browser storage eviction is outside the recovery guarantee.
An existing local replica can open before network sync; this does not guarantee
an offline cold start of application assets or authentication.

When the host refuses this account, the browser stops rendering its copy. A
`page_access_denied` answer (access removed, or a Page missing to this account,
purged included) or an access fact with a role of none retires the session for
access; `page_deleted` (a 404, or the 4404 admission close) retires it as
deleted. Sync stops first, and any comments
document lookup is cancelled. Then one IndexedDB transaction moves the
checkpoint and the live replica's copy to the recovery archive, with any
unsent comment or reply drafts from the UI, and leaves a marker in the
checkpoint's place. Each archived copy holds both documents: the Page snapshot
and `comments_snapshot` with `comments_document_id`, so comments the host
never acknowledged survive like unsent Page edits. Only then is the backend
released; a leave waits for the archive. A reload shows the same "You no
longer have access" or "This Page was deleted" notice instead of the Page.
The notice downloads every copy the archive holds for the Page as one JSON
bundle, each with its Markdown (comments, unsent comments and drafts included)
and its Automerge snapshots. A permanent deletion from Trash archives the
owner's copy the same way.

The client hides the copy for good only once the archive and marker are
committed in IndexedDB. If that write fails (quota, storage error), the session
says so and never reports the copy archived; the notice offers the tab's
in-memory export and Try again. The reload gate keeps the export as an unsaved
Page that only Download or Discard clears: it can hold comment drafts no
document receipt covers. The stored copy stays as it was. The next open reaches
the host, is refused again, and retires again; that is the retry. The host is
the access boundary, and hiding a refused copy is a courtesy on top of it.

Capturing the live copy is part of the retirement. The raw snapshots of both
documents must serialize; their Markdown is a projection that may fall back
to a note. If a snapshot fails, nothing is archived, closed or released: the
session holds its backend, both documents and the comments lookup
(`retireFailed` with `held`), and Try again captures again. The drafts the
first capture read stay with the session after the hidden Page resets the
composer and unmounts the panel; every retry merges them, without
duplicates, with any drafts the UI still holds. The
notice and the reload gate get the Markdown the replica still projects, with
the drafts. Leaving a held copy releases its backend; the reload gate keeps
that Markdown as an unsaved Page.

Retirement carries the grant it was refused under: the replica key the session
opened with, and the host access revision it last held (the refusal's own,
when the host sent one). Every checkpoint records `grant_revision`, the highest
readable access revision its writers held. The stored entry belongs to a newer
grant when its replica key names a later member generation or its
`grant_revision` is greater; owner and company access stay at generation 0, so
the revision is what tells those grants apart. A legacy entry without
`grant_revision` is judged by generation alone. For a newer grant's entry (another tab
opened the Page after access came back), the same transaction archives only the
refused tab's own copy and drafts, advances the entry's `recovery_sequence` so
later archives sort after them, and leaves the content and grant fields with no
marker. A permanent deletion from Trash reads the copy's grant before the purge
and retires under it.

An access marker only blocks: a tab that hasn't seen the refusal archives its
own copy when it next writes, and the next open the host grants writes over the
marker on the new grant's replica, never the archived one. Neither document
restores from a marker: a reopen asks the host first, and a hidden session
never opens its comments document. Every comments install reads the stored
entry before it adopts the document: a marker retires this tab too, with the
found document's unsent comments in the archive, and another grant's entry (a
different replica key, or a greater grant revision) installs nothing. While
that read runs, the found document waits where a retirement's capture reads
it, so a refusal in this tab archives it too; nothing renders from it. A
comments restore checks the stored entry against the record's grant, and the
session's own lifecycle fence, at its start and again right before the native
write; a retirement, release or replacement in between stores nothing.
A deletion marker is permanent. Trash, a refusal without a code, sign-in and
transient failures keep the copy. Discovery, reconnects, the open and save
receipts classify a refusal in one place (`classifyRefusal` in
[viewer/session.mjs](viewer/session.mjs)), so `page_trashed` shows the Trash
notice whichever request sees it first.

```text
Browser Repo + Wordgard                 Authorized HTTP / MCP operations
            | plain Automerge sync (sync/wire.mjs)  |
            +--------------------+-------------------+
                                 |
                         Page Durable Object
                         SyncHost + HostRepo (worker/plain-sync.mjs)
                         host-owned access/control state
                                 |
                         ctx.storage / runtime
                                 |
                     celld SQLite/LTX + fleet bucket
                      or Cloudflare SQLite Durable Objects
```

Catalog objects index owned/shared Pages; D1 stores server sessions and MCP OAuth
state, and (with `PAGES_CATALOG_INDEX`) a catalog projection for paginated, searchable
listings. See [Catalog index](#catalog-index). Ownership, ACLs, actor claims, credential leases, and deletion are
host state outside the document. Unknown document fields are preserved; projecting
known content is not authority to rewrite the whole schema.

The byte-store adapter delegates persistence to `ctx.storage`. The runtime owns
replication and recovery; the application does not create a second SQLite store
or upload a new document snapshot for every edit. Images have a separate private
blob binding. See [upstream integration contracts](UPSTREAM.md) and celld's
[durability guarantees](https://celld.dev/docs/guarantees/).

## Usage history

`PAGES_USAGE` is a separate D1 database, created on first use by celld. Local
builds and both deployment profiles (`page10`, `pages`) carry the binding and
the `00:05 UTC` daily cron. Each deployment's fleet prefix isolates its store;
accounts and hosts are never merged. celld 0.6.3 supports
[cron triggers](https://github.com/denoland/celld/blob/v0.6.3/docs/services/cron-triggers.md).
No host-side provisioning is required.

A second cron, `35 * * * *`, runs the auth sweep in
[auth-maintenance.mjs](worker/auth-maintenance.mjs): it deletes expired sign-in
transactions, sessions, OAuth rows and invitation index rows, and grants revoked
more than an hour ago with their tokens and codes. The sweep also runs on the
daily trigger, so the 00:xx hour sweeps twice. Usage maintenance runs on the
daily trigger only.

The existing `pages.usage.v1` emission path also queues an allowlisted projection:
UTC day and timestamp, principal id, driver, surface, action, Page id, outcome.
It stores no titles, content, emails, display names, client/model labels or
session ids. Drivers are classified as `Browser`, `API`, `MCP`, `Kilo`, `Codex`,
`Claude`, `Claude Code`, `Claude Desktop`, `ChatGPT`, `Cursor`, `Gemini`, or
`other`. `Claude` is a claude.ai connector and `MCP` an OAuth client Pages can't
name; both are labels the host assigns to a grant whose client sends none.
Unknown labels, including email-shaped drivers and a client named by its host,
retain the event as `other`. A row keeps the class it was written with, so rows
older than a label's place on this list stay `other`.
Anonymous/service events and principals containing emails after percent-decoding
are dropped. Existing console telemetry is unchanged and has its separate 30-day
retention (DEPLOYMENT.md, Telemetry).

| Table | Meaning | Retention |
| --- | --- | --- |
| `pages_usage_events` | Raw projected events | Delete days strictly before UTC today minus 90 days |
| `pages_usage_daily` | Day x principal x surface x driver x action; `count`, `distinct_pages` | Same 90-day boundary |
| `pages_usage_weekly` | Monday UTC week; active people, readers, writers, agent people/actions, collaborative Pages; no principals or Page ids | Indefinite |

An admitted browser session qualifies after 30 seconds total, even while idle
or crossing midnight. Its first visit belongs to the UTC day the 30-second mark
is reached; a still-connected qualified session counts once on each later UTC
day. Non-owners emit `page.read`, owners `page.visit`. Daily counts
union principal x Page x day across reconnects, never count `sync.open/close`.
The host emits `page.write` and `comment.write` after browser change admission,
once per session x action x UTC day; daily rollups union those too. Both native
and plain sync are covered, including comments. Host-authored tool edits do not
emit browser write signals. Writers are browser `page.create/page.write`, not
comments or agent edits. Agent actions are non-Browser `tool.call` attempts,
including failures; query the daily rows for actions per person. Successful
actions count active people, so an agent-only week is active. A collaborative
Page has successful activity from two distinct principals during the week,
including qualified visits, writes, comments and agent tool calls.

The cron rebuilds completed days and weekly unions from available raw events,
then purges in one fenced transaction. Reruns and missed days are safe. Weekly
totals freeze when their source week crosses the purge boundary; current-week
totals are provisional through `through_day`. Missed cron runs delay rollup and
purge, not event collection, until the next successful cron. Retention describes
queryable rows, not deletion from celld's historical storage epochs or backups.

Writes are best-effort: 512 queued/in-flight rows per binding per isolate,
batches of 64, a 25 ms write-behind window, and a five-second request hold.
No request or document save waits for usage I/O. Failures/overflow log a generic
drop count, with no event payload, including losses reported on stalled flushes.
A hung D1 call keeps its permit for a 60-second grace period after timeout.
Then a subsequent flush abandons the permit and allows fresh work, even if the
old request's continuation was canceled. At most one call is abandoned per
timeout-plus-grace window; late completions cannot release a newer permit.
Ambiguous batches are never retried. Restart can lose queued events.
Rollback builds ignore the separate database; restoring their configuration
also removes the cron, pausing both collection and purge without changing Pages.
A prolonged rollback requires an operator-run purge to maintain the retention
boundary; this PR performs no host operations.

Query an operator-provided, consistent SQLite snapshot, never an incomplete LTX
cache file or a writable production database. For example:

```sh
sqlite3 -readonly /path/to/pages-usage.sqlite \
  "SELECT * FROM pages_usage_weekly ORDER BY week DESC LIMIT 12;"
sqlite3 -readonly /path/to/pages-usage.sqlite \
  "SELECT principal, driver, SUM(count) AS agent_actions FROM pages_usage_daily WHERE day >= '2026-11-02' AND day < '2026-11-09' AND driver <> 'Browser' AND action = 'tool.call' GROUP BY principal, driver;"
```

## Catalog index

Each account's `Catalog` Durable Object remains its discovery list: `page/<id>`
for owned Pages, `shared/<id>` for shared or company-opened Pages. Setting
`PAGES_CATALOG_INDEX` to an epoch label (for example `1`) also projects those
entries into D1 tables (`pages_catalog_pages`, `pages_catalog_access`) so
`list_pages` can paginate by cursor and search titles without opening every
shared Page. Migrations are versioned in
[catalog-index.mjs](worker/catalog-index.mjs) and applied lazily on first use.

These `pages_catalog_*` tables are a projection: the Durable Objects are the
source of truth and reconciliation can rebuild the rows. The same D1 database
holds normative tables too, such as `page_tags`, which are the only copy of their
data and are never rebuilt or cleared by the index
([Where state lives](DEPLOYMENT.md#where-state-lives)).

Durable Objects in one isolate share module state but not I/O contexts. If the
object that started a migration resets mid-flight, its D1 call and its expiry
timer can be dropped, and a promise shared with other objects would never
settle. So objects share only settled readiness: once any attempt succeeds,
later callers use the binding without a D1 call. An object that finds no
attempt of its own starts one under its own 120 s expiry, even while another
object's runs, and never awaits another object's. Racing attempts are safe:
each migration commits with its version row in one batch, and the loser rolls
back and reads the winner's version. A failed or expired attempt is forgotten,
and the next call retries. The
[Cloudflare portability audit](https://pages.runtimed.run/p/460c48f0-dc4b-4702-af82-59910e6bebd0)
(§7) covers why celld's single context hid this.

D1 picks candidates; it never grants access. Every non-owner row returned by a
listing is verified by its Page host with the caller's credentials, and owner rows
must match the account's own Catalog entry. Each access row keeps its own title
snapshot, updated only while that principal is authorized: members on title
changes, domain readers when they open the Page, and any principal when account
reconciliation verifies it with the Page host. Search and ordering use that
snapshot, so a row left behind after revocation still carries the last title its
principal was allowed to see. Rejected rows are pruned when a listing meets them,
guarded by the revision the listing read. A listing looks ahead for one verified
row past its page; only a scan that stops at its bound (`2 × limit + 16`
candidates) returns a cursor without one, and that can only reflect stale rows
carrying titles the caller was previously authorized to see. `next_cursor` is sealed (AES-GCM, keyed from
the active session key; see [Session key rotation](DEPLOYMENT.md#session-key-rotation)) to the caller, query, `in_trash` and filters,
and expires after 24 hours. Pagination is best-effort: a Page whose title or sharing
changes mid-traversal can move across the cursor, and so can a Page whose content
changes under the activity sort.

`access` narrows a listing to owner rows (`"owned"`) or non-owner rows
(`"shared"`); every row still passes the same check. An owned-only scan never
asks a Page host about a shared row (the account's reconcile pass still advances
as on any listing). Trash and Projects hold only owned Pages, so
`"shared"` with `in_trash` or `project_id` is refused with
`invalid_list_arguments`. Under an owned parent, `"shared"` lists nothing; under a
shared parent, `"owned"` lists nothing, since only a Page's owner places Pages
under it.

`sort: "title"` orders by the caller's title snapshot (`title_search`, lowercased)
in code point order, then Page ID, both ascending, so accented and non-Latin
titles come after z. That is SQLite's `BINARY` order over the UTF-8 D1 stores,
and the Catalog fallback compares the same way over keys computed as the index
computes them. Listing titles are cut to 500 code units on a code point boundary
(`MAX_PAGE_TITLE`, the longest title `create_page` and `set_title` write; plain
sync admission still accepts a longer title merged from a browser, and
`set_title` takes such a stored title back unchanged), with lone surrogates
replaced, so a key reads back from D1 exactly as the
fallback computes it. An empty title sorts first; a missing one is stored as
"Untitled". Continuation pages compare a row value against the cursor's
position, `(title_search, page_id) > (?, ?)`, `(activity_at, page_id) < (?, ?)`
or `(created_at, page_id) < (?, ?)`, which seeks that sort's index instead of
scanning from the principal's first row. The shown title still comes from the check,
so a Page renamed since its snapshot can sit out of order until its row is
rewritten. Children of a shared parent come from IDs alone and order by Page ID
in every sort.

Every listed Page carries `content_updated_at`: when its Page host last accepted
a change to its title or blocks, or `null` when no host has reported one. It is
the host's clock at acceptance, from any writer: a browser, an agent tool, a
peer syncing old offline edits. Comments (their own document), presence, sharing,
Trash and moves don't change it. `updated_at` keeps its meaning: the newest
title, discovery or lifecycle observation. A shared Page's `content_updated_at`
comes from its host's check, like its title.

| `sort` | Order | Key | Missing key |
| --- | --- | --- | --- |
| `"activity"` (default) | newest first, then Page ID descending | `activity_at`: `content_updated_at`, else `updated_at` | falls back to `updated_at` |
| `"created"` | newest first, then Page ID descending | `created_at` | `''`, sorts last |
| `"title"` | ascending, then Page ID ascending | `title_search` | `"untitled"` |
| `"activity"` with `in_trash` | newest first, then Page ID descending | `trash_key`: `trashed_at` | `''`, sorts last |

In Trash, a Page's latest activity is being trashed, and a trashed Page takes no
edits. So `"activity"` (and an omitted `sort`) under `in_trash` lists by when each
Page was trashed: a Page restored and trashed again goes back to the top, wherever
its last edit would put it. The caller names no new sort; internally it is the
`trashed` order. `trash_key` is a virtual column generated from the Page row's
`trashed_at` (migration 7). Every build
writes `trashed_at` when it records a trash and clears it on restore, so a build
that predates the column keeps it right. A partial index,
`(owner, trash_key DESC, page_id DESC) WHERE state = 'trashed'`, holds only
trashed rows, and the Trash query walks it from `owner = ?`, joining each row's
owner access row by primary key for the title snapshot. Continuation pages seek
`(trash_key, page_id) < (?, ?)`. The Catalog fallback reads the `trash/` entry's
`trashed_at` the same way, `''` when it is missing, and reconciliation indexes a
missing or malformed `trashed_at` as null, so both sources order Trash alike,
ties and missing times included. Created and title order Trash as they order
every other listing.

A stored time is a listing time only in `Date#toISOString`'s format. Anything
else in a Catalog entry, such as a number, `"2026-10-01"` or an RFC 1123 date,
never reaches D1, never jumps the order and never fails a listing or its
cursor. Reconciliation indexes it as missing: `created_at` falls back to the
entry's `updated_at` and `updated_at` to its `created_at`, and a key with
neither is `''`; `trashed_at` falls back to null. The Catalog fallback reads the
same fallbacks, so a key with none sorts last in both, and every reconcile pass
writes the same `''` for a row it indexes, so it never moves the row. Rows an
earlier build indexed keep the time they already have: that build wrote its
pass's own time, and D1 never replaces a time with `''`. D1 keeps an earlier real time
over `''`: a row the Page host already reported keeps that report's time, as any
D1 time from the host can differ from the Catalog's (below). A host record's
trash time is converted to that format before it is indexed, in D1 and in the
Catalog's `trash/` entry alike. A non-string title key reads as `''`.

`activity_at` is a virtual generated column, so every writer keeps it current,
including a build that predates it. The Catalog fallback computes each key from
the entry the same way: `content_updated_at ?? updated_at`, and `created_at`
(else `updated_at`, as reconciliation indexes it). Owned rows converge to the
same order in both sources, but they can disagree for a while:

- A content time lands in D1 and in the owner's Catalog from one flush. If either
  write fails, the flush retries both, backing off from one minute to fifteen,
  and the two agree after the first retry that succeeds.
- D1's `created_at` starts as the Page host's first report time, which follows
  the Catalog's own creation time by the creation's latency. The account's next
  reconcile pass imports the Catalog's earlier time: at most six hours later,
  sooner after a Catalog change marks the index dirty. Until then, two Pages
  created within that latency of each other can swap places in the created sort.

A shared row's times differ by source, as they always have: D1 holds the Page
row's own creation and content times, the Catalog entry this account's discovery
time and whatever the last title projection carried.

The Page host records content activity from the `change` events on its serving
document handle (worker/content-activity.mjs). It writes `host/content-activity`
and reports at most once a minute: the first change after a quiet minute flushes
at once, later changes keep only the newest time in memory, and one flush at the
window's end writes it. A flush is one storage write, one D1 batch (the Page row
and its owner and member access rows, only where the stored time is older) and
one call to the owner's Catalog at `/internal/content-activity`, which sets the
`page/` entry's `content_updated_at` without touching `updated_at`. A Catalog
from before that route answers non-OK and the flush retries until its node runs
this build; an earlier route would have read the title-less report as a title.
Members' Catalogs get the time with the next title projection. Domain readers'
rows aren't rewritten by a flush, since a domain-wide Page can have any number of
them. The host reports a reader's row again when that reader opens the Page and
the content time has moved past the one its last report for that reader carried;
the host keeps those in memory, so its first open of each reader after a restart
reports too. The reader's own reconcile pass, run by its listings at least every
six hours, copies the time as well. Until one of those, the row sorts by its
older time. Every write
takes the later of the stored and reported time, so a delayed report never moves
a content time back, and every writer drops a time more than five minutes ahead
of its own clock, so a node whose clock runs ahead can't pin a Page to the top.
Times have exactly `Date#toISOString`'s format, the only one whose string order
is time order. A host evicted before its trailing flush loses at most that
minute. A failed flush retries with backoff from one minute up to fifteen. The
time also rides on every full row report, so a restart re-reports it. Deleting a
Page, by a purge or a tombstone, stops its recorder for good and deletes
`host/content-activity`, and with it the Page's card (see [Card previews](#card-previews)).
Trash never stops it, so a restored Page keeps recording.
A change never starts a flush itself: it queues one (`flushQueued`), and the next
live request starts it.

The `change` listener runs on the repository's scheduler loop, in the context of
the request that opened the document, so it starts nothing (see the celld notes
below). Requests run the deferred work as they start and finish, and so does a
loop each resident socket's request runs while it's open. A window timer is held
on the request that armed it, so a Page edited once still flushes at the
window's end; a longer retry backoff isn't held, and waits for the next request.

Cursors are sealed to the listing's location, kind, `access` and sort, and to
the candidate source that issued them (below). A cursor issued under one
combination never opens under another; the client gets `invalid_cursor` and
restarts. The scope names each sort by what its position's
key means: `content_activity` for `activity_at`, `created` for `created_at`,
`title` for `title_search` and `trashed` for `trash_key`. An activity cursor
sealed with no scope, or with a scope that names no sort or names `activity`,
held an `updated_at` key, so it fails with `invalid_cursor`. A Trash cursor
sealed under `content_activity` held an `activity_at` key and fails the same way;
created and title cursors in Trash keep their scopes.

A position has one shape per sort, built from the row a page stopped on:
`{key, page_id}` for activity, created and trashed, where `key` is that sort's own key and
never the row's `updated_at`, and `{title_search, page_id}` for title. The next
cursor, the position a scan refetches from after rejecting candidates, and every
source's keyset all use it. Sealed, a time-keyed position puts its key
in the payload's time slot; a title position puts its title key in a fourth slot
and leaves the time slot empty, which no title listing reads. A title cursor
carries its title key, which makes it longer: cursors may run to 8192 characters.

Page hosts report their row after creation, title changes and ACL commits. Writes
carry the committed ACL revision, so a report that outlives its timeout changes
nothing once a newer revision has landed.

Repeating a title observes nothing new, so it moves no `updated_at`. The host
stores the title it last projected, when it first observed it and whether that
observation lets writers keep their time (`host/title-projection`). After a
restart, a retried projection or a repaired report, the same title goes out with
that time, which also stays the host's `title_observed_at`. A title observation
carries `keep_time`: a Catalog entry or D1 row whose title already equals it
keeps its own `updated_at`. That covers a host restarted from a build without the
stored record, and a writer that missed an earlier projection. A title change, a
new entry or row (a discovery), an ACL commit and a restore still move it. An ACL
commit or a restore is stored without `keep_time`, so its retries and repairs
move the writers it missed; writers that already took its time keep it, since
every writer takes the later time. So a host restart never reorders a library,
even for Pages without a content time, which the activity sort orders by
`updated_at`.

A failed report leaves a marker in the Page host and repeats on its next request.
Before an ACL restriction or a deletion
is durable, the host removes listing rows best-effort; the deleted tombstone is
written only after the host record is durable. Editing and sync never wait on D1.
If D1 errors or exceeds its read budget, listing falls back to the Catalog entries
with the same cursor format. The fallback reads every entry under `page/`,
`trash/` and `shared/`: rows order by keys the entries store, not by their
storage keys, so a listing that read only some of them could put a later entry
before its cursor and end a walk without it. Owned entries are bounded by the
Page limit; shared entries grow only as Pages are shared with the account and it
opens them. Each candidate is still checked within the scan's bound. Reading and
sorting every entry costs O(entries) per listing, so a full walk costs about
entries² / limit: with the index off and 5,000 shared Pages, a listing of 50
took 48 ms and a full walk at limit 100 took 3.0 s in a local run. The fallback
serves only while D1 is unavailable, unsynced or catching up, so most listings
pay none of this.

Each account reconciles from its Catalog entries: on its first listing under an
epoch, after a Catalog change that may have missed D1, and at least every six
hours. A pass rewrites owner rows (title, timestamps, content time, state), re-verifies shared
entries and non-owner rows (using the Page host's own title observation time), and
drops owner rows the Catalog no longer has. A booted Page host's first check
also reports its row. Each listing advances the pass until about one
second, 128 entries or 16 Page checks. The deadline is checked before every D1
call and every group of four Page checks, and nothing new starts after it; only a
check group already made still commits. Worst case is the deadline plus one D1
call (2.5 s), or plus one check group (3 s) and its commit (1.5 s). Progress is
saved through the last committed entry, so a pass, which is O(account size) and
advanced only by listings, resumes exactly and does not hold the Catalog's queue
beyond that bound. While D1 calls take longer than the budget, the pass waits.

A listing reads D1 only while the account index is `ready`
([account-index-machine.mjs](worker/account-index-machine.mjs)) and no Page
index mark is pending: a pass has completed under this epoch, and the Catalog
has recorded no write since that D1 may miss. A missing D1 row would hide its
Page and could end a walk with no cursor; the Catalog entries hold every owned
Page.

A Catalog write that adds a listable entry for one Page marks that Page
(`host/index/page/<id>`, `pageIndexMarkMachine`) before it writes the entry: a
creation, a Project's content document, a Trash, restore or purge projection,
and a new entry a Page host projects, including a discovery. A creation, a
content document and a
lifecycle projection then write the owner's D1 row after the response, started
in the live request and held with `waitUntil`, and clear the mark once it lands.
So `create_page`, Project creation, Trash, restore and purge never wait on D1.
Each listing first settles up to 24 marks from their Pages' current entries: it
writes an owned entry's row as a pass would, finds a discovered Page's row its
host already reported, or checks the host within the pass's check budget and
writes its answer; a refused shared entry is forgotten. A mark clears only if
it is still the token the writer read, so a newer write's mark survives. While
a mark is pending, listings read the Catalog entries, so a just-created Page is
in the very next listing either way: from D1 once its mark settles, or from its
entry. One write never restarts the account's pass.

With the index off, no listing settles marks, so writes mark the account dirty
instead. The account is also marked dirty when a listing finds an owner row
stale. Moves write nothing to D1, since D1 rows carry no location, and mark
nothing. Creating a Project marks its Space rows dirty
(`host/index/spaces-dirty`) for the Project listing, not the Page index. A row
written for an entry that never lands is safe: an owner row needs a live,
settled entry to list, and a listing that meets one without it prunes it.

A marked account is `behind`, and an account with no completed pass under this
epoch is `unsynced`; both list from the Catalog entries while the pass advances.
Once a pass records its epoch, it reads the mark again and clears it only if it
is still the one the pass started from, so a write that lands mid-pass keeps the
account behind through the next pass. A call that doesn't finish its pass reads
the mark again before it reports `ready`, since a write can land while the
pass waits on D1.

A lifecycle projection can fail after the Page host applied the change. The
host's report then gives D1's row the new state while the owner's entry keeps
the old one. The Page's mark settles from that entry, but the lifecycle fence
keeps D1's newer state. A listing shows an owned D1 row only when the matching
entry confirms it (`page/` for active, `trash/` for Trash), so D1 lists the Page
in neither:

- After a failed restore, D1's row is active and the entry is in Trash. The
  Catalog lists the Page in Trash.
- After a failed Trash, D1's row is trashed and the entry is still active. The
  Catalog lists the Page as active.

A D1 listing that meets such a row prunes it and marks the account dirty, so
listings read the Catalog until a pass imports the entry again. Retrying the
request projects it again and both sources agree.

The two sources order shared rows by different times: D1 holds the Page row's own
creation and content times, the Catalog this account's discovery time and the
last projection's. A Page host's content flush moves D1's member rows but not the
members' Catalog entries. So every Page listing cursor names the source that
issued it (`index` or `catalog`, sealed into its context beside the scope), and a
walk continues on that source whatever the account's state is by then. A walk
that began on a ready D1 can miss only rows written while it ran, as any walk
can. If D1 can't serve a walk that began there (the database or the pass fails,
the scan's read fails, or the index is switched off), the next page fails with
`invalid_cursor` rather than resume D1's order on the Catalog. The client
restarts from the first page; the viewer's listing machine already restarts on
`invalid_cursor`. The refusal also stores a cooldown
(`host/index/unavailable-until`, 60 s, `indexCooldownMachine`). While it lasts,
no listing opens D1 except a page of a walk that began there, so the restart's
first page reads the Catalog and its walk stays there, even when D1 serves
first pages and fails later ones. Each walk restarts at most once per cooldown;
the pass and the Page marks wait until it ends. A walk that began on the Catalog
never reads D1. A cursor from an earlier build names no source;
it opens as before and continues on whichever source the account's state picks.

Title and content updates to an existing entry don't mark the account: a stale
title or time snapshot misorders a row but doesn't drop it from an unfiltered
walk. A `query` search is different: D1 matches each principal's title
snapshot and the fallback matches the entry's title, so a rename that has reached
one and not yet the other can hide the renamed Page from that source's search
until its row or entry is rewritten.

D1 refuses a `LIKE` pattern over 50 bytes
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)), and
`query` allows 200 characters. So a search binds `%…%` around the longest
prefix of the lowercased query whose escaped form keeps the pattern within 50
UTF-8 bytes (`likePattern`). The cut falls between code points, and `\`, `%`
and `_` keep their escapes. A row the cut pattern matched whose title snapshot
lacks the whole query comes back marked `unmatched`, in its place in the order.
It counts toward the scan's `2 × limit + 16` bound and moves the scan's
position, but never lists and never asks a Page host. So a long query whose
prefix many titles share can return a short or empty page with a cursor, as
stale rows can; the walk still reaches every match. Dropping those rows in the
query instead would return a short batch, which the scan reads as the end of
the walk. Every database binds the same pattern, so celld's SQLite, which has
no such limit, searches the same way, and the test D1 (`test/sqlite-d1.mjs`)
refuses longer patterns as D1 does. Without the cut, any query over about 48
bytes failed on D1. Its first page then fell back to the Catalog and pinned
the walk there, so the walk never restarted and no cooldown started, but every
long search paid the fallback's full read. See the
[Cloudflare portability audit](https://pages.runtimed.run/p/460c48f0-dc4b-4702-af82-59910e6bebd0)
(§4).
Changing the epoch value forces an immediate pass everywhere; it is not required
after a rollback, since the periodic pass and each Page host's first report after
restart repair what an older build missed.

### Shared-Page checks

A listing checks each shared candidate with its Page host (`/internal/catalog`),
up to 16 at a time (`sharedCheckBounds`); each finished check starts the next,
and one check gets 3 s. A failed check stops new ones and fails the listing
once the checks already running settle. A check that times out settles then,
but its Page host's request isn't cancelled: cancelling a Durable Object
request strands the work it started (request-hold.mjs). The same check
confirms a shared parent before a listing of its children, and names the
ancestors in `read_page` breadcrumbs.

A Page host doesn't boot its repo to answer one
([page-startup.mjs](worker/page-startup.mjs)). Booting costs about 130 ms cold:
the native repo, the document, its comments, and the lifecycle's boot effects.
The check needs only the host record and a title, so the constructor reads
`host/document` and `host/creation` and starts the host in `metadata`,
`booting` or `ready`:

| State | Starts when | A check | Any other request |
| --- | --- | --- | --- |
| `metadata` | a record this build can answer from: no creation intent, a comments document name, a storage mode the boot accepts | answers from the record | boots, then runs |
| `booting` | the constructor boots at once (a creation intent or an older record), or a request started the boot | waits for it | waits for it |
| `ready` | the boot finished, or there was nothing to boot | answers from the loaded document, as before | runs |
| `failed` | the boot threw; the runtime is resetting the object | answers from the record | gets that error |
| `abandoned` | the `blockConcurrencyWhile` holding the record read or the boot rejected while it still ran, as at the 30 s limit | gets the reset's error | gets the reset's error |

The repo boots at most once per object; every request that needs the
document waits on the same boot, and nothing reads the document before it
finishes. Both boots run inside `blockConcurrencyWhile`: the constructor's
own, or one the request that needs the document opens. That keeps the
runtime's rules for a boot. Other requests wait until it ends, and a throw
resets the object, so the next request reaches a new object that starts from
storage again. A transient failure, such as a storage read that times out,
fails only the requests the boot held. A failed boot is never remembered past
its object.

A reset doesn't stop the old object. A `blockConcurrencyWhile` past 30 s
rejects and the runtime resets the object, but the boot inside it runs on,
and so do its timers and any request already running, all writing the
storage the new object boots from. A stale write there can undo the new
object's work, such as a `host/document` put that brings back a revoked
member. So a rejection while the record read or the boot still runs leaves
the object `abandoned`, and every request still on it fails.

An abandoned object can't write. The constructor wraps its context once
([storage-guard.mjs](worker/storage-guard.mjs)), and every storage user the
host builds (the journal, content activity, plain sync) gets storage from
that context. Once the object is abandoned, `put`, `delete`, `deleteAll`,
`sync`, `transaction`, `transactionSync`, `setAlarm` and `deleteAlarm` reject
with the reset's error. A transaction already open refuses its writes too,
and rolls back if its closure lets the refusal propagate. Reads pass. The
Page doesn't use the SQLite APIs, but they're gated as well: `kv.put` and
`kv.delete` throw, and so does every `sql.exec`, since a statement's text
doesn't reliably say whether it writes.
The object also stops its own background work: content activity stops at
once. Plain sync closes once the boot itself has returned or thrown. For a
boot a request opened, that can be well after the request's
`blockConcurrencyWhile` rejected, because the repo setup builds it only at
its end; it's closed then. The
boot still checks at three points (after the repo starts, before journal
recovery of either document) so it
ends early instead of running into refused writes. A record read that ends
after the reset starts no boot. The constructor's boot is covered the same
way.

On celld 0.6.3 ([celld-boot-probe.mjs](scripts/celld-boot-probe.mjs)):

- `blockConcurrencyWhile` works from a request.
- A throw inside it resets the object. The failing request gets the error,
  a request queued behind the boot gets a 500, and the next request reaches a
  new object, whose boot succeeds.
- After that reset, a timer chain the boot started and a request that was
  already running on the old object keep writing storage, and the new object
  reads what they wrote.
- A boot that runs 35 s gets the rejection at 30 s, and the object is reset.
  The old callback still runs to 35 s and writes.
- A timer chain started inside it keeps running after the request that
  opened it has responded.

The request that opens the boot awaits it and holds it with `waitUntil`, so a
caller that goes away doesn't strand it (see the celld notes below).

A check from the record reads `host/document` again, so an ACL change or a
lifecycle change is seen by the next check: both are host record writes.
It runs the loaded host's order and refusals: authenticate with the caller's
own credentials, refuse a Page hidden in Trash or deleted, then
`policy.account`. The Page host still decides access from its own record;
D1 never grants it. The answer has the same fields as a booted host's. The
title is the one the host last projected to the Catalogs and the index
(`host/title-projection`), with its observation time and `keep` flag, and
the content time is `host/content-activity`.

The check boots instead when the record can't answer it the same way:

- a creation intent, which the boot commits or replays;
- a record an earlier build wrote without a comments document name, which
  the boot adds;
- an active Page with no stored title, or one stored without a valid
  observation time;
- an active Page whose last index report failed (`host/index/report-pending`,
  synced when written), so the loaded host's check repeats it;
- an active Page whose stored title may not have reached every Catalog
  (`host/title-projection/pending`), so the loaded host's first check sends
  it again;
- a grant holder's check of a trashed Page, which loads the document;
- an invitation the caller can claim, which the loaded host installs.

A pending lifecycle commit lives only in a
booted host's memory, which answers checks from its document. A journaled
edit a restart left pending is recovered by the boot; until then it isn't
part of the document, so the stored title can't include it.

Every `cacheTitle` (a tool edit, a save receipt, a read, a connect, an ACL
commit, a restore) stores the title it projects, so the stored title trails
the document only by a title change no booted request has projected yet, such
as a native rename from a tab that closed before its save receipt, or a store
that failed. The next booted request projects and stores it. That is a
freshness bound, not a leak: it is the title every member's Catalog was last
sent, and anyone the check admits can read the document's history, which holds
every earlier title. A revoked caller is refused before any title.

A check from the record projects nothing and reports nothing to the index.
A booted host's first check does both, and that remains the repair for a lost
projection or report. Two marks make a check boot until that repair has run:

- The projection mark is written first, and a new title is stored only once
  the mark write succeeds; if it fails, the title isn't stored and the
  projection counts as failed. The mark is removed once the latest
  projection reached the owner's and every member's Catalog and the title is
  stored. So a stored title the Catalogs may lack always has the mark. A
  failed store doesn't resend the title to the Catalogs: a later request
  retries the store alone, at most once every 30 s, with the title's first
  observation time, and clears the mark when it lands if the Catalogs already
  had that title.
- The index report mark is written after a report fails, and synced. Index
  repair is independent: a failed D1 report does not resend a title that the
  Catalogs already received. Domain-reader discovery likewise cannot invalidate
  delivery to the owner and explicit members.

`worker/title-projection.mjs` owns the title observation's storage and delivery
states. Either can finish first; both must succeed before clearing the pending
mark. Attempt tokens reject late outcomes, including an A-to-B-to-A rename.
The host serializes local mark, title-store and clear effects, so a delayed
clear cannot erase a newer mark. Catalog delivery does not wait on that queue.
The stored record and pending-key formats are unchanged.

Each reader's reconcile pass also rewrites its own access row from the
check's answer. Repeating a title projection is harmless since `keep_time`,
but a booted host's first check sends one to every member's Catalog, plus a
row report to D1. A check from the record sends neither, so a listing pays
for neither per shared Page it checks.

Each check authenticates the caller again in the Page host, as every Page
request does. The gateway forwards client requests to Page hosts, and a Page
that trusted a caller-supplied identity on this route would turn any
forwarding mistake into an access bypass; the projection route can trust its
body because it decides no access.

## Authentication and sharing

Browser sessions reuse nteract's Anaconda OIDC flow; API keys reuse its provider
verification and capability bounds. Configure OIDC and API-key principal
namespaces explicitly when they represent the same account. HTTP
authentication admits a sync socket for that account, and the host checks its
access on every frame. Disabled editor controls are not authorization.

Pages also serves OAuth for `/mcp`. Every client is public and needs PKCE S256,
resource validation, sign-in, and consent. Two kinds are admitted
([worker/oauth-clients.mjs](worker/oauth-clients.mjs)). The clients Pages names
(`pages-chatgpt`, `pages-kilo`) each have one exact callback. Any other client
names itself with a client ID metadata document: its `client_id` is an `https`
URL on a public DNS name, with the default port, a path, and no query or
fragment. By default Pages reads only three such URLs, ChatGPT's and the two
Claude publishes, and answers any other with `invalid_client`. A deployment
that sets `PAGES_OAUTH_ANY_CLIENT_DOCUMENT` to `true` reads any
([DEPLOYMENT.md](DEPLOYMENT.md#outbound-requests) says when that is safe).
Once a person has signed in, Pages fetches the URL without following
redirects, reading at most 5 KB of JSON within five seconds, and keeps a valid
document for its `max-age`, five minutes at most, in a 64-entry cache. The
document's `client_id` must equal the URL, and the requested callback must be
one it lists: `https`, or `http` on `localhost` or `127.0.0.1` where the port
may differ. A callback on the Pages hostname is refused on every port: the
browser would send the Pages session cookie there, because a cookie belongs to
a hostname and not to a port. A local server meets this with a native client
that listens on the same loopback name, and the refusal names the other one
(`PAGES_HOST`, [Run locally](README.md#run-locally)). A callback whose path has `;`, `,` or a quote is refused, so the
consent page's `form-action` always names the callback's origin and path. One
request fetches a client ID at a time; another request for it waits on its own
timer and then reads the cache ([worker/isolate-setup.mjs](worker/isolate-setup.mjs)
says why). The consent screen names such a client by the host of its client
ID, shows the host the browser returns to, and quotes the name the document
gives as a claim. The token and revocation endpoints never fetch. Dynamic
registration is disabled. Codes are
single-use; access tokens last ten minutes, with rotating refresh tokens bounded
by an absolute thirty-day grant. Correctly bound code replay revokes its
family. So does refresh replay, except within 30 seconds of the token's first
use: each use in that window gets its own tokens, so the processes of one
client that share stored tokens can refresh at the same moment. A stolen
refresh token used inside that window is not detected. Provider tokens stay on
the server. Refresh does not refresh verified
email evidence, and MCP tokens cannot authorize raw HTTP assets, sharing, or sync.
An OAuth client uploads a local image through `create_page_asset_upload`, whose
Page-scoped capability names its grant and stops working when the grant is
revoked (see [Upload capabilities](#upload-capabilities)).

A Kilo deployment also accepts a Kilo agent token as a bearer, for Kilo's agent
harness that has a Kilo session and no browser
([worker/kilo-token.mjs](worker/kilo-token.mjs); the contract is in
[DEPLOYMENT.md](DEPLOYMENT.md#kilo-agent-tokens)). A bearer is one when it is a
JWT whose unverified `aud` is `PAGES_KILO_AUDIENCE` and whose `tokenPurpose` is
`delegated-workload`; the prefixes Pages issues (`pages_`, `pu1.`) are tested
first, a Kilo deployment has no API keys, and a deployment without Kilo sign-in
never reads the claims. Pages trades the token at Kilo's
`POST /api/pages-auth/exchange` with `{token, audience}` and the deployment's
exchange secret, the call the browser sign-in makes with a code, so the person
is the same principal either way. It needs no settings beyond the three
`PAGES_KILO_*` ones. The token reaches `/mcp`, `/api/tools` and `GET /whoami`
(and the internal hops they forward to) as the person, with `credentialKind`
`kilo-token` and the driver an API key records; other routes refuse it with
403 before Kilo is asked. Like an API key, it meets the argument check, can't
send `delete_page`'s browser-only `base_heads`, and keys receipts on that
principal, so a person's browser and agent share one receipt namespace. When
Kilo's answer carries `verified_email`, the address Kilo holds proof the
account controls, the identity presents it as an API key does and claims
email invitations to it for the lease; a browser session keeps it as signed
email proof for six hours from sign-in. A value that can't be an invitation
address is treated as absent ([worker/kilo-exchange.mjs](worker/kilo-exchange.mjs)). Kilo's refusals become 401 `invalid_kilo_token`, 403
`account_unavailable` or 503 `sign_in_unavailable` (`retryable: true`); the
caller never sees Kilo's body. Each isolate leases an accepted token by its
SHA-256 until the earliest of its `exp` less 30 seconds, its whole lifetime
after the exchange was sent, and 15 minutes
([worker/kilo-token-lease.mjs](worker/kilo-token-lease.mjs)). One token's
exchanges run one at a time, so concurrent requests with a token that gets a
lease share one exchange. A token Kilo accepts without a lease authorizes its
own request for 30 seconds and is exchanged by each request. Only Kilo's
explicit refusal of a token (`400 invalid_token`, `403 account_unavailable`)
answers repeats of it, for five minutes or 30 seconds; every other answer is
a 503 and is never kept. An isolate starts no exchange while 8 are in flight,
counting each from its start until it answers (15 seconds at most), even
after its request gave up, and keeps 1,000 tokens, never by dropping a live
lease: past either bound a new token gets 503 without an exchange. An account
Kilo blocks keeps working until its lease ends. A lease can outlast the token
by the clock difference between Pages and Kilo, never by more than the
token's whole lifetime. An upload capability issued under the token ends at
the earlier of that identity's validity (the lease end, or 30 seconds for an
unleased token) and the upload's own lifetime.

The account menu's Connected agents dialog lists the account's live OAuth
connections (`GET /api/auth/grants`: client name, scope, issue and expiry
times, and an opaque per-grant handle) and disconnects one
(`POST /api/auth/grants/<handle>/revoke`). Sign out everywhere
(`POST /api/auth/logout-all`) revokes every grant the account holds, deletes its
pending consents and unexchanged codes, then deletes its browser sessions here,
this one included. An approval writes its code only while the approving
session row still exists, in the same statement, so an approval racing the
sign-out gets `access_denied` and no code. Anaconda API keys aren't OAuth
grants: they aren't listed and keep working; people revoke them in Anaconda.
Only a browser session cookie reaches these routes; a bearer
credential is refused, and writes need this origin. Grants record their
principal in an indexed column, backfilled from the identity snapshot of older
rows; sessions are found through an expression index on the session's principal
([oidc-session-store.ts](../notebook-cloud/src/oidc-session-store.ts)).
Grants issued before the column existed show no connection date. Last use is
not recorded. `GET /api/auth/session` answers `accountControls: true` for a
browser session, and the viewer offers the dialog only then. If the list
answers 404 anyway, as an ingress without these routes does, the dialog says
they aren't available here, shows no error, and the menu stops offering them.

An hourly cron (`35 * * * *` UTC, [shared/schedule.mjs](shared/schedule.mjs))
sweeps the auth database (worker/auth-maintenance.mjs). It deletes expired
sign-in transactions and server sessions, expired OAuth consents, codes, tokens
and grants (keeping a consumed code while its grant lives), grants revoked more
than an hour ago with their tokens and codes, and expired Project invitation
index rows. Each run deletes at most 5,000 rows in batches of 500 within 15
seconds; phases take turns and a persisted cursor resumes the next run where
this one stopped. It logs counts and phase names only. Request paths keep their
opportunistic cleanup. Deleted rows remain in celld's storage history and
bucket versions until those expire.

`/connect` and the public `/llms.txt` are the maintained client setup guides.
They lead with API keys, the method for coding agents, scripts, and anything
long-running or headless (Kilo, Claude Code, Codex). OAuth is for interactive
cloud clients such as ChatGPT: the client refreshes on next use, so nothing runs
in the background, and the person authorizes again after thirty days. A client
that keeps one stored token set for several processes can refresh from more
than one of them at once: uses of one refresh token within 30 seconds each get
their own tokens. Each process has to read the stored tokens before it
refreshes, because a refresh token presented more than 30 seconds after another
process spent it is replay and revokes the grant. Agents can prepare non-secret configuration while a person
creates a key or authorizes the connection; a successful `list_pages` call
verifies access.

API-key recipes send `X-Pages-Driver` (the harness, such as Kilo) and an
optional `X-Pages-Agent` session label of at most 80 characters; blank means no
label. The Kilo recipe uses one shared entry with
`"X-Pages-Agent": "{env:PAGES_AGENT}"`, and each worktree sets `PAGES_AGENT` in
its `.envrc`. Both labels are self-declared descriptions shown under the
authenticated account, not verified vendor identity or a permission grant.
A tool client can also assert an agent name and model. `_meta.agent`
(`{name, model, id}`, at most 80, 120 and 128 characters; no control or bidi
characters) rides on an MCP `tools/call` in `params._meta`, or on `POST /api/tools`
beside `operation` and `arguments`. Without it, `X-Pages-Agent` gives the name
and `X-Pages-Model` the model. A header that disagrees with `_meta.agent` is
refused (`invalid_arguments`). `id` is accepted and neither stored nor returned.
`manage_page_comment` and `reply_page_comment` store the resolved `{name?, model?}`
once, on the new message's author (`author.agent`, schema feature
`comment-agent` on the comments document); editing the message never changes it.
The assertion joins the request fingerprint of an add or reply, so the same
`nonce` with other labels is `nonce_conflict` and an exact retry replays the
original receipt. `list_page_comments`, `read_page` and `read_page_changes`
return `author.agent` when stored. The comment thread reads "<agent name> via
<driver> for <person>" with the model in the tooltip. These are what the client
said about itself, shown under the authenticated account: they grant nothing and
verify nothing. An `edit_page` call stores the resolved assertion on its
writer ([Edit writers](#edit-writers)) but leaves it out of the request's
fingerprint: a retry under the same `nonce` with other labels replays the
first attempt's receipt and keeps its writer.

`Browser` is the one driver a bearer credential can't claim: viewers show a
browser session by the person's name alone, so on a request with an API key or
OAuth token the server reads `X-Pages-Driver: Browser` (any case) as `API`.

A Page starts private. Its immutable owner manages access, Trash, and permanent
deletion, editors write/comment, commenters read and comment, and viewers read.
Each operation intersects the Page role with credential scopes. Email invitations expire after seven days, become stable
principal grants only after verified provider email admission, and do not send
email. Pending invitations cannot authorize sockets or override a newer role.
There is no public/anonymous access, guest commenting, or ownership transfer.

Company-domain sharing is optional. Deployment configuration and the owner's Page
setting must both allow it; only `anaconda.com` is currently recognized
([Company domains](DEPLOYMENT.md#company-domains)). The owner picks the
audience's role: Can view, Can comment or Can edit. A grant stored without a
role is a viewer grant. New Pages start Restricted. Existing company audiences
remain active. Enabling a company audience or raising its role requires fresh
owner proof; lowering its role or choosing Restricted does not. Browser and OAuth proof expires after six hours. API-key access uses
bounded leases backed by provider verification. A higher direct grant wins and
explicit revocation overrides domain access; removing the audience revokes it
without creating permanent members.

ACL updates use a revision and idempotency key. Increases wait for durable
confirmation; reductions apply immediately. A downgrade or removal ends the
affected sockets' write access at once and closes them with `access_changed`.
Dirty browser replicas pause with a downloadable draft rather than silently
resending rejected offline edits. Previously accepted history remains available;
revocation cannot retract downloaded documents or images. Actor claims attribute
history to the principal that first sent it; they don't authenticate arbitrary
actor strings inside imported history.

Browser sessions renew while open and on return to the tab. A return to the tab
or an explicit check that lands while a session request is in flight queues one
fresh request after it, and only the fresh answer applies (the
[session-refresh machine](viewer/session-refresh-machine.mjs)). Sync sockets retain
the expiry observed on admission and reconnect with current credentials. API-key
sockets renew bounded leases through provider verification; caching means provider
revocation is not instantaneous. A pending or late check cannot revive an expired,
disconnected, or changed grant. Page ACL enforcement is independent of sign-in renewal.

Every refusal on `/api/connect`, `/api/sync` and `/api/saved` logs one `admission.denied` JSON line with a reason from the closed set in
[admission-reasons.mjs](worker/admission-reasons.mjs). celld exports it as the
OTel log body. It names the refused boundary, not the cause of a storage delay,
and omits principals, Page IDs, tokens, messages, and content.

Clients receive only a code from [admission.mjs](shared/admission.mjs): HTTP
errors carry it as `code`; sync refusals after the upgrade close the socket with
that code as the reason. Transport refusals (oversized frames, full queues)
report a bounded category, log it once, and close with `request_rejected` or
`temporarily_unavailable`.

Cloudflare closes a socket that carries no data for about two minutes (its
125 s proxy read timeout), so an idle background tab reconnects on that
cadence. A tab reconnecting after its old socket died takes that socket's
place ([Plain Automerge sync](#plain-automerge-sync)).

A Page holds at most 24 sockets, 4 per account, and 20 across members other than
the owner. A socket over a quota still completes the upgrade, then closes at once
with `temporarily_unavailable` and logs `connection_capacity`. A browser reads a
refused HTTP upgrade only as close 1006, so the close code is what lets its
reconnect count the refusal. A discovery epoch from an earlier host stays an HTTP
409 before the upgrade: the next attempt's `/api/connect` returns the current
epoch, so it clears without counting as a refusal.

A deleted Page returns `page_deleted` only to its owner and to holders of a
current viewer/editor grant. Everyone else, including principals with a role
"none" tombstone, receives the same `403 page_access_denied` body and headers as
for an unreadable Page. A missing Page gets that response too, so admission
routes never tell a missing Page from an existing one. Tool and MCP routes
still distinguish them.

The browser reconnects with backoff on transient codes, rechecks access through
`/api/connect` on access and sign-in codes, and stops on a code whose retry is
`stop`: `page_deleted` marks the copy deleted, `schema_unsupported` asks for a
reload, and `document_format_unsupported` stops for good. A first open waiting
for the document ends with that diagnosis
instead of a lookup timeout, and the open retry loop does not reopen. A socket
counts as admitted only after it stays open 15 seconds, so quick refusals keep
growing the backoff instead of resetting it.

Each socket has 10 seconds to open (`HANDSHAKE_TIMEOUT_MS`). A proxy that
accepts the connection and then says nothing would otherwise leave the open
pending forever, and with it the session's one in-flight connect, so neither the backoff nor a
later `online` event could start another attempt and unsent edits and comments
stayed local. The reconnect machine's `handshaking` state arms the deadline
when the attempt starts and disarms it when the socket opens or fails on its
own; the deadline closes the socket and the attempt
fails like one whose socket closed: Offline without a banner, the next backoff
step, and an outage report from the seventh failure in a row. Retry during a
stalled handshake abandons it and waits for that connect to settle before its
own attempt, and a halt (sign-in, an access pause, a close) or the socket's
own close before it opens abandons it too; either way the attempt settles and
installs nothing, and a socket that opens after it was abandoned is never
used. When the open and its deadline land in one tick, exactly one of them
settles the attempt. A socket closed before it opens takes the same backoff.

Backoff steps double from 0.5 s to a 60 s cap, with equal jitter: each retry
waits between half the step and the full step, so tabs dropped by one host
restart spread out. Transient failures (no status, 5xx, a close without an
admission code or with `temporarily_unavailable`) retry indefinitely at the
capped step. Six other admission closes in a row on sockets that never proved
stable pause automatic reconnects with "Sync paused" and the Retry control,
since discovery keeps answering while the socket keeps being refused. Retry, the `online` event and signing in again clear both counters and
reconnect at once; a stable connection clears them too.
[reconnect-machine.mjs](viewer/reconnect-machine.mjs) holds these transitions.

A host restart is not an error the person can act on. A 502, 503 or 504 (JSON
or a gateway's HTML page), a JSON error marked `retryable`, and a failed fetch
are transient (`isTransientFailure` in [request.mjs](viewer/request.mjs)): the
Page shows Offline or Saved locally and retries without a red banner. A
session check or a connection attempt that runs past the request deadline gets
the same treatment (`isUnansweredFailure`): the server said nothing about the
session or the Page, so the viewer asks again. A receipt that times out still
reports it, because it holds up saving the edit. Receipts
retry on the same backoff. From the seventh failure in a row, about 15 to 30
seconds in, the Page shows one sentence, "Pages can't reach the server. Your
changes are saved on this device.", and keeps retrying; the next admitted
connection clears it and restarts the receipt. Receipts and session checks
are timed instead of counted (`OUTAGE_MS`, 20 s), because edits and Page
reconnects trigger them too: receipt failures count from the first one after
the last successful receipt, across edits, and the session-refresh machine
tracks a run of unreachable answers, so a library screen whose renewals keep
failing shows the same sentence until a session request succeeds. A tab with
no account yet shows the failed check's own error instead, since the sentence
promises saved changes it doesn't have. Both read
one monotonic clock ([monotonic.mjs](viewer/monotonic.mjs), `performance.now()`),
so changing the system time can't hide or hasten the notice. A renewal the
server refuses (401 or 403) still signs the tab out, and says why: "Your
session ended. Sign in again." or the server's 403 message, or the open
Page's own sign-in prompt. Each screen renders its banners
from one deduplicated list ([alerts.mjs](viewer/alerts.mjs)).

The status line separates syncing from saving. Every head change asks the host
for a receipt, but only a local edit marks the replica as holding unacknowledged
work. Catching up on other peers' changes after a reopen says "Syncing"; a
local edit says "Saving" until a receipt for heads that include it lands, even
if remote changes arrive in between.

A reopen decides from the restored replica, not from the checkpoint's `pending`
flag, which only says a receipt was outstanding. The checkpoint's `localEdits`
records every Automerge actor this browser authored with (each session records
its fresh actor before it accepts an edit) and the heads the host last
acknowledged. The replica has unconfirmed work exactly when it holds a change by
one of those actors outside the acknowledged history. The replica's storage
persists an edit before the debounced checkpoint, so a tab that dies in between still
reopens Saving, and its edit is not claimed as saved. Checkpoints from before
`localEdits` keep their `pending` flag as unattributed local work until a receipt
covers them. Each actor is recorded with the replica it wrote into, and
only that replica's session drops it: earlier actors once a receipt covers the
whole replica, its own when it closes with nothing unconfirmed. Another tab's
actor is never dropped, by count or otherwise, because that tab may be live or
may be restored later with its database.
[local-edits.mjs](viewer/local-edits.mjs) holds these rules.
[sync-status-machine.mjs](viewer/sync-status-machine.mjs) holds these
transitions and the label each state renders; a phase pause (sign-in, access,
deletion) or a failed local save outranks it.

Membership, invitation and connection counts are bounded. See
[access.mjs](worker/access.mjs) and the Worker tests for membership admission
and the associated resource limits. Sharing
receipts retain the latest 256 results; older retries must still pass the revision
guard, and receipt capacity never prevents revocation. Comment `displayName` and
`driver` labels are editable data, not an audit log; `author.principal` is
checked against the sending account (see [Comments document](#comments-document)).

## Comments document

A Page's comments live in their own Automerge document, owned by the same Page
Durable Object. The Page record names it by a deployment-relative id,
`comments_doc: "<uuid>"`, derived from the Page ID when the Page is created.
A live or trashed Page's record without it fails closed at boot; a deleted
Page's record may lack it and serves no comments. There is no hostname and no
origin: comments are platform data, not part of the Page. The browser syncs it
on the same socket as the Page; `/api/connect` returns `commentsDocumentId`.
Trash, restore, permanent deletion and the purge preview cover both documents.

Shape ([model/comments-doc.mjs](model/comments-doc.mjs)):
`{ threads: { [id]: { target, author, createdAt, status, messages } } }`.
A message's `author` is `{ principal, displayName, driver, agent? }`; `agent` is `{ name?, model? }`
in the `_meta.agent` bounds, set when the message is created and admitted on any message.
`target` is a cursor anchor into the Page document, `{ kind: "block", blockId }`
or `{ kind: "selection", anchor, head }`, resolved against the Page on read.
The Page's rich text carries no comment marks and no hint. Its first change is
a pure function of the id, so a host that creates it twice stores one document.
Reactions aren't implemented; the shape leaves room for a per-thread
`reactions` map, which the authority check refuses until a build adds it.

One ACL governs both documents. `read` reads both, `comment` writes the
comments document, and `edit` writes the Page. Owners and editors hold
`comment`; the `commenter` relation grants `read` and `comment` only. Per
author ([model/comment-rules.mjs](model/comment-rules.mjs)):

| Action | Who |
| --- | --- |
| add, reply, resolve, reopen | anyone with `comment` |
| edit, delete a message | the message's author |
| delete a thread | owners and editors, or the thread's author |
| move an anchor | the thread's author |

The rules hold at three layers: the viewer only offers what they allow, the
tools check them in `applyComment`, and the host checks every sync change from
a peer before it is stored ([sync/comments.mjs](sync/comments.mjs)):
[model/comment-authority.mjs](model/comment-authority.mjs) decides the change
for the sending principal and role. Content is checked by the same rule the
tools and the browser apply (`validateCommentSpans` in
[model/comment-content.mjs](model/comment-content.mjs)): non-whitespace text or
a valid embed, so an image-only comment is content, at most 16,000 text
characters and 64 KiB of spans. Every message a change creates or touches,
a soft delete included, must be rich text with no field but `richText`,
`bodyFormat`, `author`, `createdAt` and `deletedAt`. A new message, or a
write to a message's `richText` or `bodyFormat`, must also leave its spans
in the editor's form (`isEditorForm` in
[model/comment-content.mjs](model/comment-content.mjs)): what the editor's
encoder writes for what they read as, or what a merge of such writes leaves.
The check stops a message that people and agents would read differently, or
that carries data no reader shows: a newline stored as text in prose, marks
on code text, attrs a marker doesn't use, forms an earlier build wrote.
"Decode reads it without loss" isn't enough, because decode normalizes
those quietly. Two merge results are in the form: unmarked text (a peer
typed into a node another deleted), and a container whose marker a merge
deleted while a node a peer added inside it survives (a quote, a list
level, a table or row). A soft delete doesn't check the form, so a Wordgard
release that encodes differently never blocks deleting older messages. A
change that writes another form is refused as `outdated_form`.

A refused change is never stored or delivered, and every other connection
stays up. When the sender broke a rule, its principal is blocked from
authoring comments, durably (`host/comments-blocked/<principal>`), and only
its connection closes. A missing dependency, an unreadable change, a checker
error or a form only an earlier build writes (`outdated_form`: a stale tab
that hasn't reloaded) refuses the frame without blocking anyone. An honest
client never writes a refused change.

Uploads need edit access. Asset storage has no per-Page aggregate byte or
object quota yet, so comment access alone doesn't open it: commenters comment
in text and can't attach images until that quota exists.

Comment receipts carry the Page revision their write read as `revision`,
minted with the receipt, and the comments document's revision as
`comment_revision`. An agent polling `read_page_changes` from a comment receipt
still sees a browser edit that landed meanwhile, and an exact retry returns the
same revisions.

`read_page_changes` takes `since_comment_revision` for comment changes. Without
it, `comments` lists every current thread (`change: "snapshot"`) and
`comments_snapshot: true` says to replace what the caller holds, so a client
from before the comments document keeps seeing comments.

The browser opens the comments document with its own lifecycle
([viewer/comments-open-machine.mjs](viewer/comments-open-machine.mjs)): a
lookup with a 15 s timeout, retries after 1, 2, 4 and 8 s, then a visible
"Comments couldn't load" with Try again. A reconnect starts over, and a
replaced replica cancels its lookup. Offline, the local record's comments
checkpoint restores the document before lookup; checkpoints, recovery
archives and Download draft carry both documents with separate heads.

### Pages without the comments stamp

The `comments-doc` stamp on the Page says its comments live in the comments
document. A Page without it holds threads in a form an earlier build wrote;
comment reads and writes on it answer `409 stored_form_unsupported`, and the
viewer shows no comments.

## Sources document

The Page title has a read-only sources line outside the content document
([viewer/SourcesLine.jsx](viewer/SourcesLine.jsx)). It reads the session's
source store, including unused sources, and uses the existing host-document
lookup machine to discover the first source while a Page is already open.
On a visible, connected Page without sources, this holds lookup demand:
three initial attempts, then one lookup after 10 seconds, 30 seconds, and
every 60 seconds until the document exists. This also applies to Pages with
no data consumers. The first source can therefore take about a minute to
appear; once the document is open, source changes arrive through live sync.
No sources, or a sources document that hasn't arrived, renders no line and
keeps the title's normal spacing. A stored sources document supplies the
same metadata offline; this does not cache Parquet bytes.

One to three sources show alphabetical names with a database icon beside
each name. Four or more show a count and the newest/oldest last-set times;
three also use this summary below 600 px of article width. Names truncate
with their full text on hover. Revision `1` says **added**, later revisions
say **refreshed**, even when the asset is unchanged. These are host source-set
times, not asset upload times or dates inside the data. Dates are relative
for seven days, then local calendar dates; each has its exact local timestamp
on hover and in its accessible name. A minute clock updates the visible ages
without changing content. Readers and editors see the same noninteractive
line; it has no panel, refresh controls, or staleness warning.

A Page's named sources live in a third Automerge document, `pages.sources`
format 1 ([model/sources-doc.mjs](model/sources-doc.mjs)), owned by the same
Page Durable Object. Only the host writes it. Its root is `sources`, a map
from `source_id` to `{ name, revision, current: { media_type, asset_id },
producer: { kind, at, by }, history }`. `revision` is a decimal string the host
mints, `"1"` and then one more per accepted write; `media_type` comes from the
stored asset's record; `producer.kind` is `upload`. `producer.at` is the
host's ISO 8601 time for the write, read once per batch, and `producer.by`
the writer in a comment author's shape ([model/author.mjs](model/author.mjs)):
the account `principal`, `displayName`, `driver`, and `agent` `{ name?,
model? }` when the client asserted one. The asserted agent is part of the
write's retry fingerprint, so a retry that changes it is `409
nonce_conflict`. `current` and `producer` are each replaced as one map. A
Page holds up to 64 sources. No stored node draws from a source yet.

`history` is an Automerge list of the source's newest states, oldest first,
each `{ revision, name, media_type, asset_id, at, by }`. The write that
creates or changes a source appends its state in the same change and deletes
from the front past 50 states, so the last state always equals the entry's
present name, revision, `current` and `producer` as a whole, and revisions
strictly rise along the list; a read refuses an entry where either doesn't
hold as `invalid_source`, and so does a write to it. Its name is still in the
document, but no read returns it; a new `source_id` can be set beside it,
while `sources: true` refuses until the entry is gone. `history_truncated` is true when
`revision` exceeds the list's length: each write raises the revision by one
and appends one state, so only the cap makes the list shorter. Older states
remain in the document's Automerge history, but no read returns them. The
host builds every source write in the Page's queue, so two writes never share
a base; a document merged from two such candidates holds two states for one
revision and reads as `invalid_source`, never as a state neither wrote.

Each state repeats its writer, so a source stores bounded labels: a display
name cut to 200 UTF-16 code units, as the Kilo exchange keeps one; a driver
up to 80 and an agent name up to 80 and model up to 120, the bounds those
already have where a request brings them, over which the write is refused.
At those bounds a full history reads in about 122 KB, inside `read_page`'s
128 KiB default.

A full list costs about 12 KiB in `A.save` for one source with 50 writes and
693 KiB for 64 sources with 50 writes each. The document keeps every change,
deleted states included, so it grows by about 0.2 KiB per write whatever the
cap; 64 sources with 100 writes each save to 1.4 MiB.

A Page has at most one sources document, and a Page with no sources has none.
Its id is derived from the Page ID with its own label, as the comments
document's is, and its genesis is fixed, so creating it twice stores one
document. The host creates it on the first source write
([worker/sources-lifecycle.mjs](worker/sources-lifecycle.mjs)): it stores the
genesis, then writes the host record with `pages.sources` in
`documentFormats`. A restart before the record names it starts over on the
next write; a restart after it loads the document and replays its journal.
`pages.sources` is not a member type: a new record doesn't name it, and a
record that does is still held to format 1.

Browsers read it and never write it. Its type module declares no browser
write access and refuses rather than strips a browser frame that changes it:
`request_rejected`, not fatal, and the principal isn't blocked. Host writes
go through the journal and `admitTrusted`. The socket serves it only to a
client that declared `pages.sources:1`; discovery names it in
`documents.sources` once it exists. A
reader that syncs it sees each source's `producer.by` and every earlier
writer in its changes, as comment authors are visible to comment readers.

The viewer declares `pages.sources:1` and syncs the document read-only
([viewer/host-doc-replica.mjs](viewer/host-doc-replica.mjs), with its states in
[viewer/host-doc-open-machine.mjs](viewer/host-doc-open-machine.mjs)). Each
connection the host admits brings its discovery, which moves the machine:
no `documents.sources` is `absent` and looks nothing up; a descriptor at a
format this build doesn't read is `unreadable`; a discovery without a
`documents` map, or a socket that answers the named document as unknown while
still connected, is `unserved` (an older host); a named one is looked up with
the comments document's timeout and backoff. An open document stays open
across reconnects, and anything else starts over on the next admitted
connection. The replica exposes only its state and the document's value as
`doc$`; nothing in the viewer changes the document, and the host refuses any
change a browser sends for it. The document isn't in the local checkpoint or
the recovery archive: the host holds all of it. A retirement (access removed,
Page deleted) cancels a lookup, drops the document from memory and moves the
machine to `retired`, from which nothing opens it again; a reopened retired
Page opens nothing either. It does this on every path, a failed recovery
capture included. The document's synced bytes stay in the tab's replica
database, the same as the Page's and comments' synced bytes.

The host tells no open socket that the record gained the type, so a document
it creates while a tab is open isn't named until the next admitted
connection. The viewer derives the document's id from the Page id instead
([shared/document-ids.mjs](shared/document-ids.mjs)) and looks it up
on the live connection when a reader asks for a source the Page doesn't hold
and the machine is `absent`. A miss there is the host saying the document
doesn't exist yet. The lookup retries twice on the backoff, then the machine
rests in `absent` behind a look-again window: asks inside it run one lookup
when it ends, and each further miss widens it (10 s, 30 s, then 60 s). The
misses outlast a closed replica and a new connection: a lookup by the derived
id after one waits out what is left of the window, then looks once, with no
new burst. A reader still waiting on a missing source is
standing demand: while it waits, one lookup runs as each window ends, so a
document the host creates later is found; when nothing waits, nothing runs.
View documents work the same way, with a held view embed as the demand.
Before each lookup that follows a miss, the
repo's cached unavailable answer is evicted so the lookup asks the host;
eviction runs only while the repo still holds that answer and no replica has
the document installed. A Page with no sources and nothing asking looks
nothing up.

The Page's source store ([viewer/page-source-store.mjs](viewer/page-source-store.mjs))
projects the document's readable sources by id, skipping an entry the host
would refuse as `invalid_source`. `versions(ids)` emits only when one of
those sources changes. `resolve` turns `{ source_id }`, `{ source_id,
revision }` (the source's history state at that revision) or `{ asset_id }`
into `{ asset_id, media_type, revision }`. Each decoder (Sift's loader for a
table, an Arrow decoder for a chart) gets its own resolver over one byte
cache of the four most recent assets; each table decodes its own copy and
frees it when unmounted, replaced or abandoned mid-load. Released with the session, the store reads
as a Page with no sources: its versions emit null and resolve refuses. The
editor draws a dataframe's stored `binding: {source_id}` or
`binding: {source_id, revision}` through the same resolver used by views.
Asset-pinned tables keep their original `src`, which is refused before a
request when it belongs to another Page. Source-bound nodes store no resolved
asset URL. Each refresh replaces the drawn table without changing the Page
or its node/comment identity. A revision pin draws only while the source's
history still holds that revision (its newest 50 states); a table that must
keep its data names the dataset with `asset_id`.

`insert_node` takes dataframe attrs with either `asset_id` or `binding`, plus
optional `title` and `media_type`. `set_node` takes the dataframe's `node_id`
and `attrs`, without `match_text`, to change that reference in place in either
direction. These edits use the Page revision fence; target conflict scope
still requires a text match. `read_page` reports the binding and Markdown
names the source ID and optional revision. The additive `dataframe-source`
feature gates older writers. Plain rich-text tables are unchanged.

Same-Page clipboard copies retain source bindings. Cross-Page source-bound
copies paste descriptive text; copying or rebinding sources across Pages is
not implemented. Parquet bytes remain in the session's bounded memory cache;
there is no persistent browser Parquet cache.

Agents write it with `edit_page` `set_source` operations (`source_id`,
`name`, `asset_id`, `source_revision`) or `delete_source` (`source_id`,
`source_revision`) in a batch containing only source operations;
a mixed batch is `400 invalid_arguments`. `source_revision` is null to
create, or the revision the caller read. A mismatch is `409 stale_source`
and an unknown source with a non-null revision `404 source_not_found`, each
carrying `source_id` and the current `source_revision`. The asset must be a
dataset stored on this Page (`dataset_not_found` otherwise). The batch names
the Page `revision` it read and is fenced like any edit, but a newer Page
revision doesn't refuse it. The receipt carries `sources_revision` and
`result.edits` of `{ op, source_id, source_revision }`; the nonce shares
`edit_page`'s lane. A write is checked against the sources the Page holds
before the host creates the document, so a refused first write creates
nothing, and a journaled source write whose apply didn't finish is replayed
before a new one is built. `read_page` takes `sources: true`, which lists
`source_id`, `name`, `source_revision`, `asset_id` and `media_type`, and
`source_id`, which reads one source with `summary`, `producer`, `history`
and `history_truncated`; both together return
both. Alone they read no Page content; beside other selectors they add to
them. Reads name `sources_revision` once the document exists.

`delete_source` checks the source revision, returns `{op, source_id}`, and
leaves tables and views in place. All consumers of that source, including
revision pins, draw empty and identify it. An asset-pinned table still reads
its asset: deleting a source does not delete dataset files. The sources doc
retains a small `{deleted: true}` tombstone, excluded from the active source
cap and every read, so the ID cannot be reused and old pins cannot silently
resolve to a different dataset. Use a new source ID after deletion. A Page
holds at most 64 active sources and 1,024 total source IDs, including deleted
ones; existing sources can still be updated or deleted at that limit. The
journal makes deletion retries and recovery durable like source updates.

A source's `summary` describes the dataset it names now, from the Parquet
footer alone ([worker/dataset-summary.mjs](worker/dataset-summary.mjs)).
The Page host reads the dataset's end from R2 with ranged reads, at most
1 MiB of footer, and passes it to Sift's `parquet_footer_summary`, loaded
from `@nteract/sift/wasm` as a second Worker module beside
`automerge.wasm` ([scripts/worker-modules.mjs](scripts/worker-modules.mjs)).
The agent summary is stored as
`pages/<page>/assets/<asset>/footer-summary.v1.json`: an asset id names
immutable bytes, so its summary never changes, and the asset prefix that
permanent deletion clears holds it. The object is derived; deleting it costs
a recomputation. Its columns stop at 200 or 32 KiB of JSON, and a read whose
`max_bytes` can't hold the rest drops columns from the end, with
`columns_truncated`, before it refuses. A footer Sift refuses is stored as
unreadable and reads as `summary: null`. A WASM trap stores that footer as
unreadable too, and the isolate's Sift module summarizes nothing more: its
memory is in no known state, and the glue can't be initialized again.
`set_source` summarizes each named dataset after its receipt is durable, so
a later read finds it stored. A read waits at most 5 seconds for a summary
and leaves it null on a timeout or a bucket or WASM failure; the read itself
never fails for it. Purge closes the host's summaries before it deletes the
asset prefix, and a summary write still in flight deletes what it wrote.

Trash and restore keep the document. Permanent deletion deletes its stored
bytes with the Page's. Page assets are never collected, so a source's
current and earlier assets stay stored until the Page is purged.
`scripts/project-transfer.mjs` doesn't copy sources.

## Views

A view is one chart, stored in its own Automerge document of type
`pages.view` format 1 ([model/view-doc.mjs](model/view-doc.mjs)) and owned by
one Page. A Page holds up to 10. Only the host writes them. The document's
root is:

```
{
  title:      string, 1 to 200 characters; a write refuses control characters
  media_type: "application/vnd.vegalite.v6+json"
  spec:       text, the Vega-Lite spec as JSON
  data:       { [data_name]: { source_id } | { source_id, revision } }
  revision:   decimal string: "1", then one more per write
  producer:   { kind: "edit_page", at, by }
}
```

`spec` is collaborative text: a rewrite replaces it with `updateText`. `data`
names exactly the data the spec reads, each bound to one of the Page's
sources. A data name matches `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` and is never
`constructor`, `prototype` or `__proto__`; a view binds at most 32. Every map
keyed by a data name, view id or source id is built from entries or is a
`Map`, so no key reaches a prototype. `{ source_id }` follows the source's current revision;
`{ source_id, revision }` names a revision the source's `history` held when
the view was written. `producer` has a source's meaning
([Sources document](#sources-document)). `data` and `producer` are each
replaced as one map. The genesis holds an empty `spec` and `data` and no
`revision`; a document with no `revision` holds no view.

### Identity and storage

A view is named by a `view_id` its writer chooses, with the `source_id`
rules. Its document id is derived from the Page ID and the view id: the
UUID of `pages-view\0<page_id>\0<view_id>`, as the comments and sources
documents derive theirs ([shared/document-ids.mjs](shared/document-ids.mjs)
`viewDocumentId`, which the host and the viewer both import). The id is never
stored. Its genesis is fixed by that id, so creating a view twice stores one
document. A view, once created, stays for the life of the Page and can be
rewritten; there is no delete.

The host lists its views under `host/view/<view_id>`, one key per view whose
document it created, holding `{ format }`, so it never reads the Page body to
find them. The key is normative and is the view's only record: the host
record never names `pages.view` in `documentFormats`, so a host that predates
views still opens the Page. That host ignores the `host/view/` keys and the
`view:<view_id>` journal entries, and its purge clears the views' documents
with the rest of the Page's plain storage. The key is read at boot, for
discovery, for the cap and on purge. Each view has its own lifecycle
([worker/view-lifecycle.mjs](worker/view-lifecycle.mjs)): `absent`, then
`storing` (serve, import the genesis, flush), `recording` (put the key),
`ready`; at boot, a listed view goes through `loading` (serve, import, replay
its journal) to `ready`. A restart before the key is written starts over on
the next write. The host serves a view's document from `storing` on, so any
open socket can sync it once the Page body names it; nothing waits for a
reconnect.

A slot holds a view only once a write lands in it. Discovery and reads list
only views with a `revision`. Every refusal known in advance comes before a
new view's slot is taken: the checks, the cap, room in the journal
(`requireJournalRoom`, which refuses as reserving would) and a fresh
authentication of the request's own principal. A write that fails after the
slot is taken fails from I/O or a crash; the slot stays, served and
unlisted, and the next write to the id uses it. A running host never removes
a served view document, so a tab that synced the genesis keeps its
subscription. Boot releases a listed view it opened that still has no
`revision` once its journal is replayed (`releasing`: delete the document,
then the key, then sync), before any socket can hold it. A failed release
leaves the view `releasing` and the Page boots: the view is not served,
listed or writable. The next boot runs the release again, and so does the
next `set_view` to that id, which proceeds once the release finishes and is
refused `503 view_unavailable` (retryable) while it fails. A write that
finishes a release runs every pre-slot check again from the top, since the
release awaited storage. Slot allocation
runs in one per-Page queue, so the cap is read and the key written as one
step.

The Page's schema stamp gates writes to its sources and views as it does
the body (SyncHost's gate). `set_source` and `set_view` check it before the
intent is journaled and refuse with `409 unsupported_schema_feature`. While
the stamp names a feature this build lacks (a newer build wrote it, then the
host rolled back), boot doesn't replay a pending sources or view intent,
which stays pending for a build that supports the stamp; the document loads
at its stored state and the Page boots. A retry of that intent gets the same
refusal. Boot releases no empty view slot in that state either, and doesn't
import a listed view whose document a release already removed (importing
would create its genesis, which the gate refuses): the slot stays, unserved,
until a build that supports the stamp boots.

A view whose key names a format this build doesn't write is never opened:
not served, replayed, rewritten or released, and its pending intents and
document bytes are left as they are. It counts toward the cap, `set_view` on
it is refused with `409 document_format_unsupported`, and purge removes its
key and document.

Every derived document id (comments, sources, each view) is served under one
kind only. Registration refuses a `document_id` equal to the Page's derived
comments or sources id with `409 document_conflict` before it stores the
creation intent. View ids are open-ended, so a Page registered under a view's
derived id gets that refusal from the `set_view` that would create the view,
and its own document is unchanged.

Browsers read views and never write them: the type module declares no
browser write access and refuses a frame that changes one
(`request_rejected`, not fatal). A socket syncs a view only when it declared
`pages.view:1`; a client that doesn't still opens the Page. Discovery lists
the views that exist as `documents.views`, `{ [view_id]: documentId }`.

### Writes

`edit_page` `set_view` writes one view: `{ op: "set_view", view_id, title,
media_type, spec, data, view_revision }`, alone in its batch (otherwise
`400 invalid_arguments`). It names the Page `revision` it read, fenced like
any edit; a newer Page revision doesn't refuse it. `view_revision` is null to
create, or the view's current `revision`. The receipt carries
`view_revision`, the view's revision after the write, and `result.edits` of
`{ op, view_id, view_revision }`; it names no revision handle for the view.
The nonce shares `edit_page`'s lane, and the writer is recorded as for any
edit ([Edit writers](#edit-writers)) and as `producer.by`.

The spec passes `checkViewSpec` ([shared/view-spec.mjs](shared/view-spec.mjs)):
a JSON object of at most 64 KiB, nested at most 32 levels, accepted by
`checkChartSpec` ([shared/chart-spec.mjs](shared/chart-spec.mjs)), whose
refusal sentence reaches the caller as it is, and reading exactly the names
`data` binds. The spec is checked before `data`, so a spec that can't draw is
the refusal whatever `data` holds, and an empty `data` names the data names
the spec reads. `checkChartSpec` takes from allowlists:

- each unit view's mark: `arc`, `area`, `bar`, `boxplot`, `circle`,
  `errorband`, `errorbar`, `geoshape`, `line`, `point`, `rect`, `rule`,
  `square`, `text`, `tick` or `trail` (`CHART_MARKS`; Vega-Lite 6's marks
  without `image`), as a string or a mark object's `type`, in every layer,
  concatenation and inner spec;
- each encoding, condition and facet field's `type`: `quantitative`,
  `temporal`, `ordinal`, `nominal` or `geojson` (`CHART_ENCODING_TYPES`),
  in any case, or Vega-Lite's `q`, `t`, `o` and `n`;
- transforms: `aggregate`, `joinaggregate`, `bin`, `calculate`, `density`,
  `extent`, `filter`, `fold`, `lookup`, `pivot`, `quantile`, `regression`,
  `sample`, `stack`, `timeUnit` and `window`, each with ranged parameters.

A chart reads at most 100,000 rows and 2,000,000 cells from one dataset; the
viewer refuses more when it draws, and the host doesn't count rows on write.
A view stored before a check refused its spec still reads, lists, rewrites
and deletes as any view; the viewer shows the check's sentence in its place.
Refused, creating no document, no listed view and no writer record:

| Request | Result |
| --- | --- |
| malformed `view_id`, `title`, `media_type`, `data` or `view_revision` | `400 invalid_view`, naming the field |
| spec not an object, over 64 KiB, or refused by `checkChartSpec` | `400 invalid_view`, naming the spec path |
| `data` binds a name the spec doesn't read, or lacks one it reads | `400 invalid_view` |
| a data name that isn't a safe key, a malformed `source_id`, or over 32 names | `400 invalid_view`, naming the key |
| `data` names a source this Page doesn't hold | `400 unknown_source` |
| a pinned `revision` the source's `history` doesn't hold | `400 unknown_source_revision` |
| `view_revision` not the stored one, or null for an existing view | `409 stale_view` |
| a non-null `view_revision` for a view that doesn't exist | `404 view_not_found` |
| an eleventh view | `400 view_limit`, naming the ten in `details.view_ids` |
| the Page's own document id is this view's derived id | `409 document_conflict` |
| the view's key names a format this build doesn't write | `409 document_format_unsupported` |
| the Page's schema stamp names a feature this build lacks | `409 unsupported_schema_feature` |
| a release of this id's empty slot hasn't finished | `503 view_unavailable`, retryable |

A pinned revision is checked against `history` because it holds the asset of
each revision it keeps; a source keeps its newest 50.

### The Page body

A `view` node is a top-level leaf with one attr, `view_id`; feature `view`
gates it ([model/features.json](model/features.json)), so a build without it
opens a Page with one read-only. Its DOM form is `figure[data-pages-view]`
with `data-view-id`. `insert_node` with `{ type: "view", attrs: { view_id }
}` places one; the view must exist on the Page (`400 unknown_view`, naming
the views it holds in the sentence and `details.view_ids`). A malformed view
node is `400 invalid_edit_selector`, naming the field and its rule.
`delete_node` removes the node and keeps the view. Markdown reads it as the
text `[View: <view_id>]` (brackets escaped), from the node alone, with no
link: a view has no address of its own. `replace_block_markdown` keeps the
node for that exact line at the view's own place: the same count of that text
in the block, in the same container instance (a quote or list item is told
from others of its kind by order). A paragraph whose text names no stored view
is prose and is never refused, so a block can hold `[View: x]` as text beside a
dataframe. Views with different ids may be reordered among the paragraphs of
one container by reordering their lines. A view can't change container: its
line in another quote or list item, or a quote or list item of its kind added,
removed or moved before its own, is refused with `markdownless_node`, naming
the node operations (`insert_node`, `move_block`, `delete_node`) to use
instead. Identical lines make a rewrite ambiguous, so adding or removing a copy
of a stored view's line anywhere in the block is refused too. An outline entry has
`type: "view"`, `attrs: { view_id }`, and
`summary: { title, media_type }` when the view exists. Comments refuse a view
node. A view stored inside a text container reads as a notice.

### Drawing a view

The editor, editable or read-only, draws each `view` node as its chart
([viewer/wordgard-views.mjs](viewer/wordgard-views.mjs)). Cards and previews
draw the node's own figure naming its view id, and load no chart code. Near
the viewport an embed loads the chart chunk
([viewer/view-chart.mjs](viewer/view-chart.mjs): Vega, Vega-Lite and the
Arrow decoder) and holds its view while the chart is mounted.

The viewer opens each held view's document read-only by its derived id on the
live connection ([viewer/view-replicas.mjs](viewer/view-replicas.mjs)), with
the sources document's lookup machine
([viewer/host-doc-open-machine.mjs](viewer/host-doc-open-machine.mjs)): a view
whose document doesn't exist yet, such as one written while the tab is open,
is looked up again once per look-again window while its embed holds it. The
document is read with the host's reader
([model/view-record.mjs](model/view-record.mjs) `readView`): a document with
no `revision` reads as not on this Page, and a record no host write produces
reads as one that can't be read. At most 10 views have an open replica; a
view named past that waits for a slot, and a view whose document is missing
gives its slot to one that hasn't had one, so every view the Page holds
draws.

Each data name resolves through the Page's source store: `{ source_id }`
follows the source, and `{ source_id, revision }` reads that revision's
history state. Each source version is fetched and decoded once
([viewer/view-arrow.mjs](viewer/view-arrow.mjs)) into Arrow IPC bytes. Each
chart sends its own copy to the chart Worker, which reads the values as a
chart reads them ([viewer/chart-arrow.mjs](viewer/chart-arrow.mjs)): decimals
at their scale, 64-bit integers and times as numbers, nested values as plain
arrays and objects. A data name whose source is missing, or whose pinned
revision the history no longer holds, draws as no rows with one sentence
naming the source under the chart. A spec `checkChartSpec` refuses, or one
the renderer refuses at draw, shows its sentence; a chart that throws
draws nothing and says it couldn't be drawn.

`read_page` takes `views: true`, listing `{ view_id, title, media_type,
revision, data }` for each view, and `view_id`, which reads one with its
`spec` and `producer` (`404 view_not_found`, `400 invalid_view` for a
malformed id). Alone they read no Page content.

Trash and restore keep the views. Permanent deletion deletes every listed
view's document with the Page's, then the `host/view/` keys.

## Authorization

### Current behavior

Capability checks use `decide()`. Grant identity and deletion disclosure use separate projections of the same relation model. The function lives in [authz.mjs](worker/authz.mjs):

```text
decide(principal, actor_chain, object, now)
  -> { capabilities, valid_until, revision, authority_token, basis }
```

It is pure and synchronous, and the celld policy hooks call it on every frame.
It reads what the Page host already holds: the Page record's ACL and lifecycle.
`pageAccess`, the socket lease bound and the Project read check are projections
of its result. `pageGrant` reports grant identity (role and generation), which
Trash keeps. `pageRelation` answers deletion disclosure and
the lifecycle owner check. It reads the same relations without the lifecycle
overlay.

The adapter builds a view scoped to one principal. It holds the owner (or the
project), company view, and only that principal's member row. A decision
therefore costs one member lookup, however many grants and removal tombstones
the ACL has collected.

A commenter holds `read` and `comment`: it writes the comments document, never
the Page. In `schema.zed`, `comment = edit + commenter` and `read` builds on
`comment`.

Capabilities are named: `read`, `comment`, `edit`, `share`, `administer`,
`trash`, `restore`, `purge`, `create_items`, `manage_members`, `move_within`,
`move_out`. A Page never gets `manage_members`, and a project never gets
`comment`. Nothing checks the `move_*` capabilities, because moves don't exist
yet. Execute is out of scope for Pages.

decide() runs three steps, in this order:

1. **Relations.** A viewer, commenter or editor member row grants, and a removal
   tombstone becomes `removed`. A company domain grant is an
   `organization#member` userset in the relation its role names. Built-in mode
   has no tenants, so the verified email-domain lease stands in for
   organization membership. A tombstone subtracts from the item's own viewer,
   commenter and editor paths, so it beats a company grant at any role. A Page placed in a
   Project has the `project` relation instead of `owner`.
2. **Lifecycle overlay.** A trashed item keeps `read`, `administer`, `restore`
   and `purge`, and only for principals who may restore it. A deleted or
   missing item grants nothing. The overlay runs after every relation, so no
   grant can reopen a trashed item.
3. **Credential ceiling.** A credential without write keeps only `read`.

`revision` is nteract's own ACL revision, which only increases and which every
`expected_revision` write compares. `valid_until` is the credential's expiry,
or the first earlier lease whose loss would change the capabilities. The
email-domain proof is such a lease. Sync sockets use it as their lease
bound. `basis` names the strongest relation that survived the lifecycle
overlay and the path that supplied it. It feeds the `role` label and
`source: "domain"`. `authority_token` is always null in this build.

Built-in project ownership is synthesized from the Page owner. External leases
and token round-tripping are not wired. Every Page in a Project is owned by the
Project's owner, including a Page an editor adds, so a Page's project copy names
the Page record's owner. A Project editor holds `read` and `create_items` on the
Project itself. `decide()` already drops inherited paths when a project copy
carries a `valid_until` in the past, but no built-in copy carries one.

Built-in callers always pass `NO_ACTOR_CHAIN`. This build has no verified
delegation, and driver labels (`x-operator`, `x-pages-driver`) are attribution
only. An agent's API key or OAuth token authenticates as the person, and its
scope is the credential ceiling.

One timing difference from the rules decide() replaced: the Project read check
now requires an unexpired credential, as Page checks always have.
`authenticate()` returns an unexpired credential, but the Project then reads the
request body and its record before it checks access against a fresh clock. A
credential that expires during those reads is refused as `project_not_found`.
Before, the owner was admitted.

### Schema invariants

[schema.zed](authz/schema.zed) is the model, written in SpiceDB's schema
language. It defines `user` (a person), `organization`, `group`, `project` and
`page`, and the proposal's rewrites: `project.contribute`, `project.read_items`,
and the item's `administer`, `edit`, `read` and `share`. Each capability is a
permission of the same name. Agents hold no grants and never appear as
subjects. An item has a `project` or an `owner`, never both. SpiceDB can't
express that, so writers must keep the two exclusive. decide() refuses a copy
that holds both.

[fixtures.json](authz/fixtures.json) lists relationship tuples, a lifecycle and
each principal's expected capabilities. [authz.test.mjs](worker/authz.test.mjs)
runs every row through decide(). The `modes` field marks rows only a host could
produce: groups, organizations on projects, project editors and viewers, and a
leased project copy. The agent row checks only that a non-empty actor chain
leaves the person's decision unchanged.

SpiceDB matches 14 fixture cases after removing local overlays. Writers enforce
owner/project exclusivity; the malformed case tests JavaScript rejection only.
When SpiceDB's `zed` is installed (not the Zed editor's command of the same
name, which the test never runs), the test runs `zed validate` with the lifecycle,
credential ceiling and project lease removed, so SpiceDB computes the same
relation decision as decide() for every principal. Without it, the test
parses the schema structurally.

[authz-equivalence.test.mjs](worker/authz-equivalence.test.mjs) compares
decide() with the rules it replaced, frozen in
[access-legacy-fixture.mjs](worker/access-legacy-fixture.mjs). It covers 63,000
combinations of lifecycle, placement, company setting, member row, credential
expiry, write scope and domain proof. It also counts member inspections with a
1000-tombstone ACL, to check that a decision stays O(1).

### Proposed host integration

None of this is wired. A hosting platform would implement `decide` with the
same signature over a leased copy of its own relations, and only step 1 would
change. The lifecycle overlay and the credential ceiling stay with nteract:

- The copy would hold the item's relations and its project's. The host's
  change feed (a watch stream) would refresh it, with pushes for quick
  revocation and a lease to bound staleness. Batch checks would run when the
  copy refreshes, never inside a policy hook.
- When the lease expires and the host can't be reached, inherited access
  would fail closed, and `valid_until` would report the lease.
- `authority_token` would carry the token the copy was read at, such as a
  SpiceDB ZedToken. Nothing would compare it for ordering. `revision` stays
  nteract's.
- A refresh that removes access would go through `installAccess`, which closes
  affected sockets as a built-in ACL change does.

## Private images

An image has a default/light `src` and optional `dark_src`, with shared `alt`
and `title`. The `image-theme-variants` feature is stamped only when a dark
source is written and never removed. Baseline images remain baseline. Agents
use `insert_image.dark_asset_id` or `edit_page` `set_image` with the image's
`node_id` reported in `summary.images`, at exact heads. Both assets are
preflighted as images belonging to the Page; deleted cursors never slide.
Comments deliberately accept only baseline images.

The Wordgard widget and boot preview share the resolved Pages appearance store
and image lifecycle. Each source attempt creates a fresh image element; stale
events are ignored, and dark-source failure falls back once to a distinct default
source. Browser lazy loading owns the wait, with no offscreen timeout. Clipboard
serialization still emits one canonical image with inert preservation metadata.
Project-transfer bundle v4 carries structured variant occurrences and both asset
references, deduplicates uploads per destination Page, and applies variants using
destination live IDs. Truncated occurrence reads fail rather than silently losing
variants. Versions 1 through 3 remain importable; old importers reject v4.

Browser upload, screenshot paste, and file drop send PNG, JPEG, or static WebP to
`POST /api/pages/:pageId/assets`. Only a stable Page-scoped reference and alt text
enter Automerge. Image bytes use the private `PAGES_ASSETS` R2 binding, backed by
the fleet object store on celld. Immutable hash-addressed assets avoid repeated
uploads; they do not consume the document history budget.

Uploads check current edit permission before transfer and again before returning
the asset. Transfer does not hold the Page mutation queue. Browser insertion
captures a CRDT cursor and refuses to redirect a completed upload into a replaced
block or revoked editor. The cursor sticks to the character before the insertion
point, so text typed while the image uploads goes after it. When the upload
lands and the selection hasn't moved since the paste, drop or pick, the caret
moves to just after the image; otherwise the selection stays where the person
put it. `GET`/`HEAD /api/pages/:pageId/assets/:sha256` check current
read access before lookup, then return verified raster MIME, `nosniff`, and
`Cache-Control: private, max-age=31536000, immutable`: the URL names the
SHA-256 of the bytes, so a reader's browser keeps them. Refusals, errors and
upload results are `private, no-store`. Bytes already in a reader's cache stay
there after their access is revoked; the next request is still checked. No
public bucket, persistent presigned URL, or cross-Page hash lookup is exposed.

The same route stores Parquet datasets for dataframe nodes. On upload the
Worker checks only the container: `PAR1` at both ends, a footer length that
fits, and no encrypted footer. It decodes no column data; a source's summary
decodes the footer through Sift ([Sources document](#sources-document)). A dataset is
served as `application/vnd.apache.parquet` with `Content-Disposition:
attachment`, so opening its URL downloads it. `insert_image` refuses
datasets; `insert_node` checks with `HEAD` that its
asset is a dataset of the node's media type on the same Page.

Current limits are 5 MiB per image or dataset, 8192 pixels per side, and 25
million pixels; the HTTP request ceiling is 6 MiB. SVG, HTML, GIF, APNG, and animated WebP are not
accepted. Container validation is not full pixel decoding. Removed images and
interrupted uploads may leave private objects: immediate deletion would break
undo or offline references. Asset garbage collection and copying assets between
deployments require a separate lifecycle implementation.

A dataset copies between Pages with `POST /api/pages/:pageId/assets/:sha256`
and a JSON body `{"from_page_id": "<source Page>"}`. The Worker asks the
destination's host for edit access first and the source's host for read
access second, as a read of the source asset would, and touches neither
Page's storage until both pass. A caller who can't read the source gets that
read's refusal whether or not the dataset is there. The source object must be
a Parquet dataset; its bytes go through the upload's own checks and limits,
are stored under the same id, and edit access is checked again before the
answer. A dataset already on the destination is `200` with no second write;
a new copy is `201`. Upload capabilities can't copy. Images don't copy: an
image pasted from another Page keeps its `src` there.

For agents, importing bytes and inserting content are separate operations:

1. Get the bytes into the Page's asset store, by one of three paths:
   - Any client with a shell or HTTP client, on an API key or OAuth, calls
     `create_page_asset_upload({page_id})` and POSTs the file to the returned
     `upload_url` with the returned `Authorization: Pages-Upload <token>`
     header (see [Upload capabilities](#upload-capabilities)).
   - API-key clients may also POST raw bytes to the asset endpoint with their
     own bearer header.
   - A client that attaches a file to the tool call itself passes that file
     descriptor as `create_page_asset_upload({page_id, file})`. ChatGPT does,
     through `openai/fileParams`. The Worker handles that call at its edge
     ([import-file.mjs](worker/import-file.mjs)): it requires read/write scope
     and Page edit access, accepts bounded HTTPS downloads from the hosts in
     `FILE_HOSTS`, today only `files.oaiusercontent.com`, without redirects,
     stores an image or a Parquet file under the upload's checks, and returns
     `asset_id`, reference, MIME, size and an image's dimensions. With `file`
     the call takes no `content_type` or `size`. A file ID alone is not a
     download URL. Temporary source URLs are not stored in the document.
     `import_page_image`, which took the same arguments, is refused with
     `tool_renamed` naming `create_page_asset_upload`.

   A client with none of these asks the person to upload in the browser.

   Every stored asset's answer, from an upload, a dataset copy or an import,
   also carries `insert`: the `edit_page` operation that places it as the
   block its type calls for (`assetInsertOperation` in
   [image-assets.mjs](worker/image-assets.mjs)). A raster gets
   `{"op": "insert_image", "asset_id": "<asset_id>"}`, and the agent adds alt text, which
   `insert_image` requires; a Parquet dataset gets
   `{"op": "insert_node", "node": {"type": "dataframe", "attrs": {"asset_id": "<asset_id>"}}}`.
2. Read the current Page, then call guarded `edit_page` with that `insert`
   operation: for an image, `insert_image`, `asset_id`, alt text, and optional
   `after_node_id` (omitted appends; `null` prepends). The host verifies the asset belongs to this Page and creates a
   dedicated image block. Its `result.edits` entry returns the new block's
   `node_id`, its `nodes`, the image's id as `image`, and the asset reference;
   the receipt adds updated heads and the Page URL. Exact retries reuse that result.
3. Read back the block. Upload success alone is not insertion or proof of rendering.

The MCP schema declares `_meta["openai/fileParams"]` for the client handoff. No
base64 argument or extra API key is needed for that route. Client catalog refresh
may be necessary; a generated ChatGPT image must actually be exposed as a
transferable file. The importer does not provide image-reading capability or
imply pixel access from a Markdown reference.

The agent guide's Images section (`/llms.txt`, from
[agent-guide.mjs](agent-guide.mjs)) is the agent-facing workflow: which path to
use, sizing for the ~960 CSS px desktop column and ~350 px phone column (images
render at natural width, capped at the column), light and dark uploads, the
one-batch pattern that interleaves `insert_image` and `insert_markdown`, and
verification through `summary.images`.

### Upload capabilities

`create_page_asset_upload` ([asset-uploads.mjs](worker/asset-uploads.mjs)) lets
any agent that can run curl add a local file without handling its own bearer
token. It is a Page content tool on MCP and `/api/tools`, takes `page_id` or
`project_id`, and needs write scope plus current edit access. API-key and
OAuth clients can issue one; a browser
session is refused, since the browser uploads to the same route with its
cookie. The Page host answers with `upload_url` (the ordinary
`POST /api/pages/:pageId/assets` route), `method`, `headers`, `expires_at`,
`max_bytes`, `accepted_types` and `example`, a ready curl command built by
`assetUploadCommand` ([agent-client-setup.mjs](agent-client-setup.mjs)), which
also builds the `/llms.txt` line. Optional `content_type` and `size`
arguments bind the capability to one type and byte count; the gateway checks the bytes against
them before storing anything (`upload_mismatch`), and a bound size refuses a
different `Content-Length` before reading the body. A credential-less upload
to the asset route is told to call `create_page_asset_upload`.

The capability is `pu1.<payload>.<mac>`, an HMAC-SHA-256 signed with the Page
host's existing retry-token key ([operation-journal.mjs](worker/operation-journal.mjs)
`signCapability`/`openCapability`). The MAC covers a purpose string,
`pages-asset-upload-v1`, ahead of the payload, and the payload repeats it, so a
retry token never verifies as a capability or the reverse. The payload names
the Page, principal, credential kind, OAuth grant ID (for OAuth), issue and
expiry times, the issuer's company domain lease when it holds one, and the
optional binding. The expiry is 10 minutes after issue, or the end of the
company domain or organization lease the caller edits through when that comes
first; a caller who edits without one (owner, member, Project member) gets the
full 10 minutes. `expires_at` in the answer is that same expiry. No server
state is created.

The upload sends it as `Authorization: Pages-Upload <token>`, a header rather
than a query parameter so access logs and `Referer` don't carry it. The gateway
recognizes that scheme only on `POST /api/pages/:pageId/assets`; it skips
`authenticate()` (the capability never reaches the API-key verifier or the
OAuth token store) and keeps the Origin check. Every other route refuses it,
and `authenticate()` refuses a `pu1.` token sent as a bearer credential. The
byte route's own code does the rest: the gateway forwards only the capability
to the Page host's `/internal/assets/authorize` for both the pre-transfer and
post-transfer checks. Every other gateway path runs `authenticate()` before it
reaches a Page host, so the host screens a capability request before it may
join its queue (`uploadScreen`): it reads only the host record and its own key,
checks the MAC, payload and expiry, and refuses a forged, foreign or expired
token without queuing it or loading the document. A missing Page has no key, so
it refuses with the same body as a forged token. In the queue, the host checks
all of that again, checks that an OAuth grant is still live
(`oauthGrantActive`), and decides access for the named principal from its
current record. A grant removed or downgraded after issue, a revoked OAuth
connection, a recovery-blocked Page or a trashed Page is refused. Limits,
validation, storage and the response are the byte route's.

Revoking an API key doesn't end the upload URLs it already issued: the host
never holds the key, so they stop at `expires_at`, at most 10 minutes later.
Removing the principal's Page (or Project) access, or revoking an OAuth
connection, ends them at once.

Base64 bytes in a tool argument and a server-side fetch of an arbitrary URL
were rejected: the first makes the model emit megabytes of tokens, and the
second reopens outbound fetches the importer deliberately limits to
`files.oaiusercontent.com`.

## Persistence and resource limits

Local Repo completion means local history is recoverable. Remote edit visibility,
peer heads, and an online connection do not prove durable storage.
`POST /api/saved?page=<id>` waits for the host's plain history to cross the
configured durability barrier before acknowledging heads.
The browser retains pending state through bounded receipt retries; sign-in failure
pauses them until renewal. A client timeout does not cancel or reorder persistence.

### Request limits

celld admits at most `CELLD_MAX_CELL_REQUESTS` requests (64 in 0.6.3) to one
Durable Object at a time. A request counts from admission until its context is
quiet: the response has been sent, every `waitUntil` promise has settled, and
every timer the request or a callback of one of its timers created has fired or
been cleared. A timer that reschedules itself from its own callback keeps the
request that started the chain counted for the chain's whole life. At the limit
celld answers the stub fetch itself, before any Pages code runs for that
request, with a plain-text `503 cell request limit reached`, and logs
`cell_overload_refused` with `in_flight` and `limit` (about one line per
second; the count understates). The gateway turns that body into the JSON
refusal `503 page_busy` with `retryable: true`, `retry_after_ms` and a
`Retry-After` header ([host-busy.mjs](worker/host-busy.mjs)); a refused request
did no work, so the same request, key and token can be sent again.

Cloudflare reports the same conditions by throwing from the stub fetch
([error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)).
Past its soft per-object limit it queues, then throws an Error with
`overloaded: true`; a transient failure such as a lost connection or a reset
throws one with `retryable: true`. The gateway's stub wrapper answers both as
JSON refusals instead of its generic `500`, naming the object it called (this
Page, your account's Catalog, or this Project). Any other thrown error is
unchanged. Each mapped error logs `host.overloaded` or `host.transient_failure`
with the binding name only.

- An overload is `503 page_busy`, like celld's refusal: the object did not run
  the request. Cloudflare says overloaded calls should not be retried, since a
  retry adds to the overload. So the refusal asks for a longer wait than
  celld's 1 s: 2 to 5 whole seconds at random, the same in `retry_after_ms`
  and `Retry-After`, and the agent guide asks for exponential backoff.
- A transient failure is `503 page_transient_failure` with `retry_after_ms` and
  `Retry-After`. The object may have started the request. A tool request is
  told what its repeat safety allows, as a timeout is: a read, a progress
  renewal or a write with a valid `nonce` is `retryable: true` and replays its
  receipt; any other write is `retryable: false` and told to read back and
  reconcile; a progress creation gets the lease advice. Outside the tool API
  the refusal is `retryable: true` and gives both pieces of advice.

The same flags reach code inside an object. A listing that meets a shared Page
(or its owner's Catalog) that throws or doesn't answer refuses with
`503 shared_page_unavailable`, `retryable: true`, `retry_after_ms` and
`Retry-After`; an overloaded Page asks for the jittered 2 to 5 s. MCP passes
every one of these codes through, and the viewer treats any `503` as an outage and
retries with backoff. The
[Cloudflare portability audit](https://pages.runtimed.run/p/460c48f0-dc4b-4702-af82-59910e6bebd0)
(sections 6 and 7) covers both cases.

The host keeps its own holds short. A tool write flushes before it answers and
sets no timer. Agent presence sets no timer: its entries carry `idle_at` and `expires_at`, the host
prunes when it next reads or publishes the roster, and viewers apply the times
on their own clocks (see Agent carets). Before this, every `edit_page`
stayed counted for 60 s, the caret's fade and expiry, so a Page that
was already near the limit refused every request for a minute after one edit
([#4654](https://github.com/nteract/nteract/issues/4654)).
[comments-scale.test.mjs](worker/comments-scale.test.mjs) builds a Page with
200 threads and 1,000 messages and checks that an `edit_page` holds no timer,
leaves no timer behind
(tracking through the background work, so a timer a callback sets is seen),
that the work settles within budget, and that reads during that window succeed.

### Outbound edits

Every editor transaction is one Automerge change, and the browser stores it in
IndexedDB at once. Sending is grouped: the backend's `scheduleLocalSync` hook
hands each local store's sync round
to [outbound-sync-machine.mjs](viewer/outbound-sync-machine.mjs). A round and
the newest caret go out 30 ms after typing pauses, and every 100 ms while it
doesn't. The window losing focus, `beforeunload`, a save receipt and leaving
the Page send at once. A hidden tab or `pagehide` sends what waits and stops
batching until the tab shows again: a browser may throttle or freeze a hidden
tab's timers while saves still finish. Delivery before an unload is best
effort; the round starts and the browser decides whether it completes. A
closing session sends anything waiting and then stops batching. The grouping
removes per-keystroke sync rounds and caret frames. `scripts/typing-batch-smoke.mjs` (the
`typing` E2E suite) types 200 characters at 60–100 ms and at 20 ms per key and
reports changes, frames, bytes and the other writer's main-thread time. The
20 ms run may take one round and one caret per four keys, plus one for each
100 ms the writer spends past the typing schedule or catching up on saves
after the last key; a slow runner's store latency sets that catch-up time.

If stored history references a change that never became durable, the Page
starts on the history that materializes, logs `page.history_incomplete` with a
count, and runs journal recovery. Readers that pass admission see
`history_incomplete` in read results and `historyIncomplete` from
`/api/connect` until a peer or a pending intent supplies the missing parents.

Tool requests to a Catalog or Page answer
within 60 seconds; a slower one returns `504 request_timeout` while the host
finishes the work it accepted. For a read, a progress renewal or clear
(`progress_id` and `lease_token` name the session) or a write that carried a
valid `nonce`, the timeout is `retryable: true` and says to retry the same
request; the receipt replays. For any other write it is `retryable: false` and
says to read back and reconcile, since the host may have completed the write
and nothing keys a receipt for it. A progress creation is `retryable:
false` with the lease advice: a repeat would mint a second session, and a
lost creation leaves an indicator that expires within 60 seconds. The same
split applies to MCP's `outcome_unknown` when no answer arrives at all.

No gateway request awaits a promise that another request may still be settling.
celld 0.6.3 resumes a promise continuation under the request whose I/O settled
the promise. A request that awaits another request's pending promise runs inside
it, including the Page fetch it forwards, and loses its timers and I/O when the
other request responds. Continuations inside Durable Objects keep their own
context. Without this rule, a tab's concurrent `/api/saved` and `/api/connect`
after a restart can leave a stuck `/api/connect` holding the Page's serialized
HTTP queue, and the tab stays at "Saved locally". Nothing in that queue bounds a
request, so it stays held until the object is discarded.

[isolate-setup.mjs](worker/isolate-setup.mjs) applies the rule. The gateway
sets up each D1 schema (server sessions, MCP OAuth) once per isolate. Work in
front of the API-key verifier's cache, which shares pending lookups, runs one
lookup per token at a time. The request that starts the work awaits it; others
wait on their own timers and give up with a retryable `503` after 10 seconds. A
lookup's starter gives up at 10 seconds too. A setup's starter waits up to 30
seconds, the attempt's deadline, so slow setup that finishes in time still
succeeds. At that deadline the attempt expires: the starter gets the same
retryable `503`, the next request starts a new attempt, and a late result from
the abandoned one changes nothing. That retry runs fresh work because
setup callbacks hold no pending promise of their own: the shared session store
(`oidcDatabase`) caches only settled schema readiness. A lookup key stays held
until its lookup settles, or for 65 seconds, past the cache's 60-second
lifetime for an entry. The OIDC libraries' discovery,
signing-key and UserInfo caches, the ChatGPT client metadata check and the
loopback issuer's key still share pending promises across requests (#4567). Remove it when celld keeps request context across shared
promises; [celld-context-probe.mjs](scripts/celld-context-probe.mjs) then exits 0.

The current resource envelope is 16 MiB of aggregate history and 900 KiB per
record ([model/limits.mjs](model/limits.mjs)). The host checks a tool edit
against them before it journals the intent, and SyncHost refuses a sync write
past the history bound with `history_capacity`. These guards do not bound all
decoded WASM state, runtime-owned outgoing queues, or total isolate memory.

Recovery validates pending changes before modifying the serving document. An
older over-capacity intent leaves accepted history readable but blocks writes
with an explicit recovery error; it is never silently discarded or rebuilt from
JSON.

Resident WebSockets reconnect after restart. Hibernation, cross-host ownership
transfer, power-loss/bucket failover, and larger resource envelopes need separate
qualification. Runtime adaptations such as the Worker-only CBOR Uint8Array path
are source-checked and regression-tested; a passing storage probe alone does not
qualify ephemeral presence. Diagnostics exclude provider messages, credentials,
request bodies, and document content.

### Plain Automerge sync

Every Page syncs with plain Automerge sync messages; its host record says
`recordStorage: "automerge"`. A record naming any other storage (a Subduction
Page from an earlier build) is refused with "Unsupported Page record storage
mode", unless the Page is deleted. A draft registers on plain sync whatever
`record_storage` it names.

Browsers keep Repo 3 and run `AutomergeSyncBackend`
([sync/backend.mjs](sync/backend.mjs)), a `SedimentreeBackend` that keeps a
mirror Automerge document per tree and speaks CBOR frames
([sync/wire.mjs](sync/wire.mjs)) over the authenticated WebSocket. Repo
receives a whole document as one `document` record (an `A.save()` chunk; see
`patch-document-record.mjs` in [UPSTREAM.md](UPSTREAM.md)) and increments
as loose commits. History is stored as a snapshot plus chunks under one
manifest per document ([sync/doc-store.mjs](sync/doc-store.mjs)): IndexedDB in
the browser ([sync/idb-byte-store.mjs](sync/idb-byte-store.mjs)) and the Page's
Durable Object storage under `plain/` on the host. Every write is one
`saveMany` that puts the manifest last, so a manifest never names a missing
object. Manifests are written only at `sync/<doc>/m2`, preferred over legacy
`m` on read. The legacy key is removed after the new manifest is durable, so
an old viewer cannot misread v2. Version 2 manifests hold seq, snapshot and heads; chunk descriptors
have separate keys, read from snapshot.seq + 1 through manifest.seq. An append
writes constant metadata in chunk count. Legacy inline chunk lists remain
readable and upgrade on the next compaction. A document compacts into one
snapshot once it has more than 256 chunks, or its chunks are over both half
the snapshot and 64 KiB. The byte
rule means a rewrite of a large Page follows at least half its size in new
history; the count bounds the reads a cold load makes. The host compacts after
the ack. A failed attempt is logged (`request.failed`, stage `plain-compaction`)
and later writes back off: each
failure in a row doubles the writes that skip compaction, up to 256
([sync/compaction-machine.mjs](sync/compaction-machine.mjs)).

On the host, [worker/plain-sync.mjs](worker/plain-sync.mjs) runs a `SyncHost`
([sync/host.mjs](sync/host.mjs)). Browsers connect to it directly; the host's
`HostRepo` facade ([sync/host-handle.mjs](sync/host-handle.mjs)) gives tools,
comments and lifecycle code stable handles over SyncHost's single live document.
Trusted host edits apply exact recorded changes through the same per-document
queue; `flush()` waits for `durable()` and the worker's storage barrier. No host
Repo, backend mirror or trusted transport is needed. Borrowed snapshots remain
readable across commits and rely on Automerge's GC finalizer for reclamation. A
sync message carrying changes is checked in that queue before anything is
stored:

1. The connection's access, from `DocumentPolicy.account`, on every frame and
   every delivery: lease, ACL generation and role, trash and recovery.
2. The role gate. A connection that can't write the document has its changes
   stripped; the rest of the message stands.
3. A preview on a clone of the live document. Missing dependencies are refused;
   changes the host already holds are dropped, so re-sending accepted history
   is a no-op whoever sends it.
4. Actor claims. Each new change's actor is unclaimed or claimed by this
   principal. A claim is written in the same `saveMany` as the history it
   covers, and no other document can claim the actor meanwhile.
5. The schema-feature gate and the 16 MiB history bound. Then, for the Page
   document, the block shape
   ([model/block-shape.mjs](model/block-shape.mjs)). The blocks the changes
   write come from their decoded ops and each object's `objInfo` path (at the
   change's own heads when the object is hidden). Every value at such a block
   id must be a map, and every value of its `position` a raw-string fractional
   index of at most 512 base-62 characters and of its `richText` text, so a
   value that loses a conflict is judged at the frame that brings it, not when
   a later delete reveals it. `blocks` must stay a map. A block holds no key
   but those two. Admission applies no marker rule to the text: a merge of
   a delete and concurrent typing can leave content no marker opens
   (unmarked text), and every reader reads it. Deleting and moving
   blocks pass. A refusal is `invalid_block`, not fatal: the socket stays open, the
   principal isn't blocked, and the browser stops offering the refused heads
   until it synchronizes again. The cost follows the change, not the number of
   blocks. Trusted host writes skip this check.
   For the comments document, `admitCommentChanges`. A comment rule refusal
   blocks the principal's comment writes (`host/comments-blocked/<principal>`)
   and closes the socket.
6. Persist, publish who wrote the changes (`actor-profiles`, ahead of the
   changes), reply, then fan out.

A refusal leaves the live document and every connection's sync state as they
were. The browser gets `{ t: "refused" }` and, when fatal, a close with the
admission code (`schema_unsupported`, `access_changed`, `sign_in_required`).
Each browser refusal logs `page.sync_refused` with its reason (`actor_claimed`,
`schema_unsupported`, `history_capacity`, `receive_queue_full`, …), the first
per connection and reason at once and its repeats counted into one line once
the closed connection has no frame left running, so a frame refused after the
close counts too. Each connection also logs `page.sync_rounds`, its sync-round
latency from frame arrival to ack, summarised every 256 rounds and at close rather
than per keystroke ([worker/plain-sync-log.mjs](worker/plain-sync-log.mjs)).

Journaled host edits use a fresh actor per mutation: the Page host's persisted
random eight-byte prefix followed by eight random bytes. Concurrent producers
can build candidates from the same heads without sharing an actor sequence.
SyncHost refuses new changes from browsers under this prefix, including actors
it has never seen; trusted host changes need no per-edit claim. Existing host
claims remain readable. Chunk parts, the descriptor, any browser claims and
the manifest share one DO put for ordinary appends; the journal's pending and
terminal writes remain separate barriers.

Attribution is host-attested: an actor binds to the first authenticated
principal that sends a change with it. With no signatures, the host can't tell
who authored offline history that reaches it through someone else, so a
relayed change from an actor the host hasn't seen binds to the relayer. A
relayed change from a claimed actor is refused.

Discovery and the socket carry `sync=automerge`; a build without it gets
`schema_unsupported` ("Reload to update"). The socket also carries `formats`, the
document formats the build reads, as sorted `type:format` pairs
(`pages.comments:1,pages.page:2`). The Page's host record names its
documents' formats (below). A socket whose `formats` lacks one of the
record's member types is closed as `schema_unsupported`, and the viewer shows
"Reload to update". Every member type the record names is required, because a
Page can gain its comments document while a socket is open. A type a Page may
hold beside them, `pages.sources` or `pages.view`, isn't: a socket without it opens the Page
and its comments, and plain sync doesn't serve it that type's documents (a
frame naming it is answered as for an unknown document). A socket with no `formats` is
a 400, as is a repeated or malformed `formats`. Discovery takes no `formats`
and stays open to every reader; its `documents` descriptors carry the
record's formats. Presence ids are per tab (`sender`), stamped by the host
on every relay.

#### Document formats in the host record

A Page's host record (`host/document`) stores the format of each of its
document types as `documentFormats`, `{ "pages.page": 3, "pages.comments":
2 }`. Creation, registration and a Project's content document all stamp the
formats the build writes ([model/document-types.mjs](model/document-types.mjs)),
the comments format included, since the comments document is created at
boot. The host adds `"pages.sources": 1` once it creates the Page's sources
document. It never adds `pages.view`: each view's format is stored with its
`host/view/<view_id>` key ([Views](#views)). `recordDocumentFormats` is the one
reader; it reads a record without the field as naming no formats.

A record without the field, or whose formats aren't exactly the ones the
build writes, opens
neither document. Discovery, the socket (closed `4427`), `/api/saved`, every
agent read and edit, comments, presence, image uploads and card uploads
answer `409 document_format_unsupported`, and the viewer shows "This Page is
stored in a format this version of Pages doesn't open. Its owner can delete
it." with no reload. A tab that holds a cached copy keeps showing it read-only
(the format gate, [viewer/format-gate.mjs](viewer/format-gate.mjs)): no
typing, formatting, paste, image, title or comment writes reach it, and the
status reads "Read-only" with no Retry. A device with no cached copy shows
the message and no Page. A retained creation intent for such a record installs
the record and imports no document. The shared-Page check and sharing still
answer from the record, so the Page keeps its listing title. The JSON card
and card image the host stored earlier are still served (`page_cards`, the
card-image route): like the stored title, they are projections, and they
show the owner what they are deleting. Its owner can trash, restore and
permanently delete it: receipts carry the title the host last projected
(`host/title-projection`), a trash that names a `revision` is refused as
invalid, and the purge preview describes the record with `comment_threads`
and `comment_count` null. Permanent deletion removes its stored documents
by id, as for any Page. `stored_form_unsupported` keeps its own meaning: a
stored form inside a document or draft that this build doesn't read.

A browser may still hold a local copy saved beside a Subduction replica, from
before every Page was plain. Its checkpoint is plain Automerge, so the tab
restores it into a plain replica, unconfirmed edits included, and sends the
host what it lacks. A local copy with no checkpoint this build can read is
discarded; the Page opens from the host with a short notice
(`LOCAL_COPY_DISCARDED` in [viewer/session.mjs](viewer/session.mjs)).

A tab keeps its `sender` across reconnects, so a socket asking for an id an
open connection holds for the same principal and driver is that tab
reconnecting, usually after its old socket died without the close reaching
the host. The new socket takes the id and the connection slot, and the host closes the old one with `access_changed` and
logs `plain_session_replaced` ([plainSender](worker/plain-sync.mjs)). An id
held by anyone else, or a malformed one, is replaced by a fresh id. A reload
starts a new id, so a reloaded tab's dead socket still holds its slot until
the close arrives.

Each browser connection may have 256 sync frames or 32 MiB waiting in the
host's queues, counting a frame until it is stored and acked or refused
([sync/receive-queue.mjs](sync/receive-queue.mjs)). Over either, the host refuses the frame with
`receive_queue_full` and closes with `temporarily_unavailable`. An ephemeral
message over 64 KiB is refused with `ephemeral_too_large` and closes with
`request_rejected`; presence is a few hundred bytes. The host's own
connection has no receive limit. Each preview is a clone of the live
document; the host frees every preview it doesn't adopt and the live
document an adopted one replaces.

Edits from the API go through the host's Repo and the same admission queue.
`sync/*.test.mjs` covers the backend, host, store and gates;
`worker/plain-sync.test.mjs` covers registration, restart and a browser
through the Page host; `npm run test:contract` runs Repo 3's
backend contract.

### Edit writers

A journaled mutation a caller asked for (`edit_page`, including a title or
source write, and comment writes) records its writer
([worker/host-writers.mjs](worker/host-writers.mjs)). The writer is the
`authorOf` shape comments and sources store: `{ principal, displayName,
driver, agent? }`, its display name cut to `WRITER_LIMITS` as a source's is
([model/author.mjs](model/author.mjs)). `agent` is the request's resolved
`{ name?, model? }`. A comment or source write fingerprints it, as before; an
`edit_page` request's fingerprint leaves it out, so a retry under the same
nonce with other labels replays the first attempt and keeps its writer, and a
build without writers computes the same fingerprint for the same request.

The change keeps the host actor every journaled host edit has, the prefix
and eight random bytes, and carries the writer id as its own Automerge
`author`: the first eight bytes of the SHA-256 of the canonical writer
record. Automerge's `setAuthor` mints a fresh random actor, so the mutation
sets the author on one clone and the host actor on a clone of that, which
keeps the author. The author is in the change bytes the journal holds, so a
retry and startup recovery replay it unchanged. The record is stored once per
distinct writer, as CBOR under `plain/writer/<id>`, in the same put as the
pending journal entry that holds the change bytes; the entry names it as
`writer`. An edit that changes nothing stores no record and names none. A
different record already stored under an id refuses the write
(`writer_conflict`).

Trust rule: an `author` is believed only on a change whose actor is under the
host prefix, because only the host authors under that prefix. Any peer can
set any author on its own changes; on any other actor the field is ignored
and the writer is the actor's claim. A host change with no author (the host's
own edits: registration, migrations, direct handle changes; and every host
edit stored before writers were recorded) or an author with no record names
no writer. Nothing reads a writer out of an actor. Writer records and claims are never
removed by an access change, so a removed member's edits stay attributed to
them; a purge deletes them with the rest of `plain/`. Nothing lists
`plain/writer/` at startup or on connect: a change read resolves the
changes in its delta, one storage read per distinct writer.

`read_page_changes` checks its arguments and baseline, then decodes the
changes since the baseline once, and takes each change's actor and `author`
from that decode. A host-prefixed change resolves through the record its
author names (`via: "tool"`), any other through its actor's claim
(`via: "sync"`). A host claim, an unclaimed actor, a host change without an
author and an author without a record are `{ recorded: false }`. A browser
actor's claim answers for its edits however old they are, so what reads
unrecorded is the host's own edits, host edits made before writers were
recorded, and edits by an actor with no recorded claim. The response has
`attribution: "block"`, a `writers` table, `written_by` on every content change and `title_written_by`
beside a title change: indexes into `writers` of the authors of every change
since the baseline that wrote that block or the title. Ops resolve to blocks
as admission resolves them ([model/block-shape.mjs](model/block-shape.mjs)
`changeWrites`); a change that writes the blocks map itself writes every
block. A node change names every writer of its block. The table holds only
writers some reported change or the title names, and counts toward
`max_bytes`.

More than `ATTRIBUTION_MAX_CHANGES` (10,000) changes between the baseline and
the current heads is too many to attribute in one read
([model/read-changes.mjs](model/read-changes.mjs)): the delta is returned
whole, with `attribution: "unavailable"`, `attribution_reason:
"too_many_changes"` and no writers. The read never fails for this. An agent
that wants writers reads again from a newer baseline. Past the limit the read
counts the changes but decodes none.

### Page quotas

Each account has one Page limit. It bounds the account's active Pages and,
separately, its Pages in Trash. [page-quota.mjs](worker/page-quota.mjs) resolves
it from the first match of:

| Rule | Matches |
| --- | --- |
| `email` | the account's server-verified email, normalized as invites normalize it |
| `domain` | that email's domain, lowercased; subdomains don't match |
| default | `PAGES_DEFAULT_PAGE_QUOTA` for the deploy target, 250 when unset |

A matching rule replaces the default, so it can lower it. `0` pauses the
account: it can't create or restore Pages, but it can still move them to Trash. A quota never deletes or hides existing Pages. Only server-verified email
counts: an API key's whoami email, or the HMAC bindings a browser session or
OAuth grant carries. An identity without one gets the default without reading
D1. Rules live in D1's `pages_quota_rules` table, which the gateway reads whole
(at most 1,000 rows) once per isolate every five minutes. A failed or slow read
gives every account the default for 30 seconds and logs the failure; it never
lifts a limit.

The gateway forwards the resolved limit as `page_limit`, beside the caller's
arguments, on Catalog calls that can add a Page to either listing
(`create_page`, `register_page`, `create_space`, `delete_page`, `restore_page`)
and on `list_pages`. The Catalog stays the authority for the count. It keeps
`host/count/active` and `host/count/trash` equal to the number of `page/` and
`trash/` keys, reservations and pending creations included
([catalog-counts.mjs](worker/catalog-counts.mjs)). Each counted write runs in
one storage transaction that reads the key's existence and the stored counts
and writes both, and counted writes run one at a time, so concurrent writes in
a settle pass never derive counts from the same value. Memory caches the counts
only after a transaction commits; a failed write invalidates the cache. Below the limit
a check reads only the stored count. At the limit, or before the counts exist,
it counts every entry, releasing stale reservations, and rebuilds them. Every
`list_pages` reads every owned entry for location anyway and rewrites counts
that disagree, logging `catalog.count_repaired`; a rollback build that writes
entries without counts leaves that to repair.

At the limit, creating or restoring returns `409 page_quota_exceeded` and moving
to Trash returns `409 trash_capacity`, each with `limit` and `count`.
`list_pages` returns `quota: {limit, count, trash_count}` for the caller's own
account, whatever the listing's filters, and `principal`, the account that
answered. `list_projects` returns `principal` too. The Pages library shows usage from 90% of the limit.

A Page a Project editor adds counts against the Project owner's limit, never the
editor's. The owner's verified email never reaches an editor's request, so the
owner's Catalog applies the limit its own gateway last forwarded with the
owner's `list_pages` (`host/page-limit`), or the target default before the
owner has listed. A full owner limit refuses the editor with
`409 project_owner_quota_exceeded`, carrying `limit` but not the owner's count.

## Build updates

Each build has a 12-character id: the start of its source fingerprint, also
recorded as `build_id` in `dist/build-receipt.json`. The Worker reports it as
`build` in `/health` and in an `X-Pages-Build` header on every `/api/*`
response; the viewer bundle embeds the same id. The Worker also advertises
`minViewerProtocol` (header `X-Pages-Min-Viewer-Protocol`), the oldest viewer
protocol it serves. Both live in [build-identity.mjs](shared/build-identity.mjs).

The viewer compares on every response it already reads (reconnect, saves,
session refresh), when a hidden tab becomes visible, and every 10 minutes while
visible. It never polls while hidden and never reloads by itself.

| Server advertises | Viewer shows | Editing |
| --- | --- | --- |
| Same build | Nothing | Unchanged |
| Different build (newer or a rollback), floor at or below this viewer | "App updated. Reload to use the latest version." | Unchanged |
| Floor above this viewer's protocol | "App updated. This tab can't edit until you reload." | Paused; accepted edits keep saving |
| Editor chunk failed to load, server on another build | "App updated. This tab can't edit until you reload." | No Page opens until reload |
| Editor chunk failed to load, same build | "The editor didn't load. Reload to try again." | No Page opens until reload |

The banner sticks below the header, and below the formatting toolbar when it's
pinned, so it stays in view while the Page scrolls. It names the app, not
"Pages", which is also what people call their documents.

The viewer is `app.js`, which renders the shell (header, account, sign-in and
the Page list), plus content-hashed files under `/chunks/`. `app.js` imports the
editor chunk at boot, and that chunk waits for the WASM runtimes; the
[editor-load machine](viewer/editor-load-machine.mjs) tracks the import. The
index routes, `/projects` and `/pages`, only list, so they render from the
shell and its static chunks alone. They start the editor import when a Page
opens or a new Page is created, or a little earlier when a pointer goes down on
a Page row. A
release serves only its own chunks, so a tab still running an earlier `app.js`
can find its editor chunk gone: the path then answers with the app's HTML and
the import fails. The tab asks `/health` for the build and the banner offers
Reload. The Mermaid renderer loads only when a diagram shows, and the Sift
table chunk only when a dataframe shows; a failed import asks `/health` the
same way.

Every file `index.html` names carries a content hash too: `app-<hash>.js`,
`app-<hash>.css`, `theme-<hash>.js` and `automerge-<hash>.wasm`, plus
`mermaid-<hash>.js` from the editor chunk and
`sift-<hash>.wasm` from the Sift table chunk. The
hash is the first 40 bits of the file's sha256 in base32. `_headers` serves
each hashed file `public, max-age=31536000, immutable` by its exact path, so
a return visit revalidates only `index.html`, which stays
`max-age=0, must-revalidate`. A retired name falls through to the app's HTML
with the default revalidating header, never the immutable one. The reload
fetches the current `index.html` and, through it, the current files.

Reload covers everything the tab holds. It pauses edits and waits until every
accepted edit on the open Page has a durable host receipt. If those edits can't
be saved (signed out, access removed, local storage failed, or 15 seconds
without a receipt), the banner says why and the tab stays open. Opening another
Page while Reload waits cancels it. A voluntary attempt that fails resumes
editing; a raised floor keeps its own pause.

A Page the person just left keeps syncing for up to 10 seconds, then closes and
writes its IndexedDB checkpoint, which reopening imports. The tab then releases
that Page's session and keeps only its account, id, title and whether the
checkpoint was written. When a closed Page's edits never reached the server:

| Checkpoint | Reload shows |
| --- | --- |
| Written | "Edits on _title_ haven't reached the server yet. They're saved in this browser and sync when you open that Page again." with Reload anyway and Open _title_ |
| Failed | Names the Page and blocks Reload. Download edits and comments, then Discard unsaved edits and reload (or acknowledge the loss first) |

The download is one Markdown file: the Page body, then an "Unsent comments"
section with every comment, reply or edit the host never acknowledged, each
under the passage it was attached to. A failed record outlives reopening the
Page, since the reopened replica can't contain what its checkpoint failed to
write. It clears only when a host receipt includes all of its heads, or when the
person confirms Discard unsaved edits. Records are keyed by account and Page id.

Each Page session moves through the
[viewer-session machine](viewer/session-machine.mjs): opening, open, paused
(sign-in, access, Trash or access reload), draining while it is left, then
checkpointing or closed. A refusal retires it instead: retiring while the
archive writes, then retired or retireFailed; Try again moves a failed archive
back to retiring. A failed capture is retireFailed with `held`: the backend
stays until Try again or a leave. `PageSession.phase$` is that state in a
[Store](viewer/store.mjs), and every lifecycle flag derives from it. A close
can grow while it runs (a late refusal adds its archive), so the close itself
is private and `closeSettled()` is the only way to wait for it. The
[SessionHost](viewer/session-host.mjs) owns the installed session and every
session still closing. The [reload gate](viewer/reload-gate-machine.mjs) follows
the host and each owned session's phase, so no caller registers a session with
it, and keeps its records as plain data. Their tables,
[viewer-session](test/fixtures/machines/viewer-session.json) and
[reload-gate](test/fixtures/machines/reload-gate.json), run against both
transitions and through PageSession and ReloadGate.

Deliberate differences from the earlier flag-based sessions:

- Closed means the final checkpoint settled; backend release may still be
  running. Reload waits for the release.
- A Page closed without the drain (sign-out, unmount) is closing until its
  release settles, like a Page left through the drain, and keeps the same
  record if its edits never reached the server. Closing a held Page cancels a
  waiting Reload.
- A deleted or revoked Page archives its local copy before it releases its
  backend. It counts as closing, and Reload waits for it, until both settle.
  A failed archive keeps the tab's export as an unsaved record.
- Leaving during access reload waits for archiving and the replacement-open
  attempt.
- If the replacement fails to open, the archived Page stays installed with
  Reload current Page, which retries the open without archiving again.
- A second Reload while one waits joins it. Reload after the tab started
  reloading repeats the reload.

An unsent comment or reply, on an open or resolved thread, blocks Reload until
it is sent or discarded. A draft that can't be sent (edits paused, write access
gone, or the thread resolved) stays visible read-only with Copy and Discard.

The floor pauses supporting browser viewers; it does not enforce compatibility
for older viewers or API clients. Viewers built before this mechanism never read
it, and a tab that was offline can reconnect later with edits it accepted under
an older protocol. Remove a server compatibility path only after all of these
hold:

1. Every supported viewer reads the floor.
2. The floor has excluded the older viewers for a full support window.
3. The server can still drain edits older clients already accepted, or rejects
   them without losing them (the client keeps a local draft and says so).

Raise `MIN_VIEWER_PROTOCOL` and `VIEWER_PROTOCOL` together in one release. MCP
and HTTP tool compatibility is versioned separately and does not follow this
floor.

## State machines

Each async lifecycle (an operation, a Page's trash state, a viewer session)
gets named states, named events, and one pure transition function.
[machine.mjs](shared/machine.mjs) defines them:

```js
const lamp = defineMachine({
  name: "lamp",
  states: ["off", "on"],
  events: ["flip", "hold"],
  initial: "off",
  unreachable: [["on", "hold", "only an off lamp can be held"]],
  transition(state, event) {
    if (event.type === "hold") return reject(state, "held");
    const name = state.name === "off" ? "on" : "off";
    return { state: { name }, effects: [{ type: name === "on" ? "light" : "dark" }] };
  },
});
lamp.step({ name: "off" }, { type: "flip" }); // { state: { name: "on" }, effects: [{ type: "light" }] }
```

- A state is a JSON object whose `name` is one of `states`. Events and effects
  are JSON objects with a `type`. `step` validates both sides and returns
  `{ state, effects, response?, rejected? }`.
- A guard that refuses an event returns `reject(state, reason)`: the same state,
  no effects, a reason, and optionally a `response` for the caller.
- `unreachable` lists `[state, event, reason]` pairs that can't happen by
  construction. `step` throws on them. Late or duplicate events are reachable;
  answer them with `reject`.
- `validate` holds domain checks keyed by name:
  `{ states: { [name]: fn }, events: { [type]: fn }, effects: { [type]: fn } }`.
  Each `fn` throws to reject. They run on the initial state, every input and
  output, and every table row. Declaring `effects` makes its keys the only
  effect types allowed.
- `cases` names the guard outcomes of a pair, such as
  `{ "connecting/closed": ["current-generation", "stale-generation"] }`. Each
  row on that pair names its `case`, and every case needs a row. State and
  event names can't contain `/`.
- The transition never reads storage, the network, clocks or randomness. An
  interpreter at the edge runs the effects and turns replies and timers back
  into events. Worker interpreters keep the Durable Object's promise tails;
  viewer interpreters use RxJS.
- Persist state and outbox together; return success only after the required durability barrier.

To add a machine:

1. Write the table as JSON in `test/fixtures/machines/<name>.json`: `machine`,
   `states`, `events`, `unreachable`, optional `cases`, and `rows` of
   `{ case?, state, event, expect: { state, effects, response?, rejected? } }`.
2. Drive the current code through an adapter:
   `await runTable({ name, states, events, unreachable, cases, validate }, loadTable(file), { drive })`.
   `drive(state, event)` sets the old code up in `state`, delivers `event`, and
   reads the result back.
3. Extract the transition with `defineMachine`, make the old code its
   interpreter, and run the same table with `runTable(machine, loadTable(file))`.

[machine-test.mjs](shared/machine-test.mjs) fails when a state × event pair has
neither a row nor an unreachable entry, when a declared case has no row, when a
row covers an unreachable pair, or when the file's names, unreachable pairs or
cases disagree with the machine. Coverage is exhaustive over names; add rows for each guard outcome.
Rows compare `state`, `effects`, `rejected` and `response` exactly, including
whether `rejected` and `response` are present. To skip one row's response,
write `"response": { "$ignore": true }` (`IGNORE` in JavaScript). Without
`drive`, the runner also checks that the transition leaves its input untouched
and returns the same result twice. The JSON file is the contract a port to Rust
would replay. [machine.test.mjs](test/machine.test.mjs) runs one table against
both a machine and flag-style code.

Viewer state lives in a [Store](viewer/store.mjs): one private
`BehaviorSubject`, `snapshot()`, `update(fn)`, and `select(project, equals)`,
which emits synchronously and then only on change. Components read
`useStore(store, project, equals)`, built on React's
`useSyncExternalStoreWithSelector`. It memoizes on the store, `project` and
`equals`, and compares with the last committed value. Pass a named comparator
when `project` allocates. Test timers with `TestScheduler` from `rxjs/testing`,
as [store.test.mjs](viewer/store.test.mjs) does for a backoff interpreter.

## MCP Events groundwork (not enabled)

[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
supports webhook-triggered work in ChatGPT Work and dots. Pages does **not** yet
advertise the `events` capability or implement `events/list`, `events/subscribe`
or `events/unsubscribe`. There are no live subscriptions, durable subscription
store, event outbox, webhook deliveries or event-triggered wakeups in this slice.
`read_page_changes` remains a net-diff read tool, not an event log or replay feed.

`worker/mcp-events-wire.mjs` is an internal, unconnected foundation for that
implementation: strict wire-shape parsing, principal-scoped deterministic IDs
from canonical JSON, finite lease calculation, and exact-byte Standard Webhooks
HMAC signing (including dual signatures for a bounded rotation window). These
helpers do not authorize an event, validate its product-specific argument schema,
verify a callback, or establish delivery. Lease defaults and maximums are explicit
caller policy; a request for indefinite retention receives the finite default.
No event names or payload schemas are advertised yet. The signer accepts a
serialized body; its caller must validate the event envelope and payload before
signing and reuse the returned body without reserialization.

The next slice must qualify a safe webhook transport in Pages. HTTPS URL syntax
checks are not SSRF protection: both verification and delivery must resolve and
validate public destination addresses at connection time, pin the connection to
that address while verifying TLS against the original hostname, reject redirects,
and bound request time and response bytes. celld 0.6.3 exposes socket APIs, but
Pages does not yet have a qualified resolver, pinned TLS and bounded HTTP client
for this use. Ordinary `fetch` after a separate DNS check is insufficient.

Before enabling discovery, the Page host must atomically publish events alongside
admitted, persisted changes from both browser sync and tool edits. The common
boundary is `sync/host.mjs` persistence (`store.append(..., extra)`), not a
post-admission callback: those callbacks run after persistence and swallow errors,
leaving a crash gap. The plain-sync write hook excludes trusted tool writes, and
content activity coalesces changes and excludes comments. Neither is an event
source. Change listeners can also run after a celld request ends, when starting
I/O is unsafe. A durable subscription owner and delivery outbox still need to be
designed. Use stable occurrence IDs across retries, not snapshot differences or
activity counters. Subscription creation must authorize filters, verify a fresh signed
challenge before application data is sent, persist the granted expiration and
scope cached verification to principal and callback with a bounded lifetime.
Refresh and unsubscribe must be idempotent and owner-scoped, with revision fences
for competing refresh, revocation and delivery work. Recheck authorization and
expiry before delivery, including account disconnection and Page/Project access
revocation. Persist retry progress, bound exponential backoff, and stop retrying
`410`/`413` responses. Rotate secrets with a bounded dual-signature window, avoid
logging secrets or callback URLs, and enforce the 256 KiB UTF-8 body limit. Do not
advertise Events until this lifecycle is tested through restart, revocation,
failed verification, retry and concurrent unsubscribe, then qualified in ChatGPT.

## HTTP and MCP tools

`POST /api/tools` accepts `{operation, arguments}`; `POST /mcp` exposes the same
Page operations through Streamable HTTP MCP. Two REST routes run operations the
gateway already has, as thin wrappers (`worker/rest-api.mjs`): `GET /api/pages`
and `PUT|DELETE /api/pages/<page_id>/tags/<tag>` ([Page tags](#page-tags)). MCP accepts a Pages OAuth access
token or Anaconda API key in `Authorization: Bearer ...`; `X-Pages-Driver` is an
optional client label and `X-Pages-Agent` an optional session label. OAuth
scopes and current Page permissions apply on every call. The public `/llms.txt`
is the tool usage and authentication reference.

`/mcp` serves two protocol eras on the one endpoint, both statelessly
([mcp.mjs](mcp.mjs), on `@modelcontextprotocol/server`):

- A request that declares `io.modelcontextprotocol/protocolVersion` in
  `params._meta`, or names a 2026-07-28 or later revision in
  `MCP-Protocol-Version`, is served under 2026-07-28. There is no `initialize`
  and no `Mcp-Session-Id`; `server/discover` returns the supported versions,
  capabilities, instructions and server identity. The standard headers
  (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) must match the body
  (400, `-32020`), the envelope must be complete (400, `-32602`), and any
  other version gets 400 with `UnsupportedProtocolVersionError` (`-32022`,
  `data.supported`, `data.requested`). `ping` is not part of this revision
  and answers 404 with `-32601`.
- Every other request is legacy: `initialize` negotiates a revision from
  2024-10-07 to 2025-11-25, and responses are single JSON bodies.

A single `tools/list` or `ping` message needs no credential: tool definitions are
static and carry no account data. `initialize`, `server/discover`, `tools/call`
and every other method return the OAuth challenge without one, so MCP clients
start sign-in from their first such request. A presented credential that fails
still gets the challenge.

Other endpoints include `/api/access` for sharing, `/api/connect` for native
admission details, `/api/sync` for binary WebSockets, `/api/saved` for durable
receipts, and the browser routes `/p/<page_id>/meta.json` and `card.json`
and `/project/<project_id>/meta.json` and `card.json`
([Link previews](#link-previews)). OAuth metadata is public at
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`; authorization, token exchange/refresh,
and revocation use `/oauth/authorize`, `/oauth/token`, and `/oauth/revoke`.

Every address an agent reads or sends is a `node_id`: the Automerge op id,
`<counter>@<actor hex>`, of a block's map object, a top-level node's opening
marker, or an image's embed ([model/addresses.mjs](model/addresses.mjs)). Op
ids are unique in the document, so an id names its block too. The host resolves
one by comparing it against the ids minted from the live document; it never
hands a caller's id to Automerge. Each operation field takes the kinds it acts
on and refuses another with `wrong_address_kind` (400); an id that names
nothing live is `node_not_found`. A block's key in `doc.blocks` stays internal
to the browser, sync, presence wire and comments document.

Reads capture content and heads together. Agents can select blocks or nodes by
`node_ids`, exact heading sections, or literal hits with neighboring nodes.
`include_content:false` provides a paginated outline; explicit read projections
use bounded response budgets and never silently truncate content. Partial slices
are suitable for literal edits, not whole-block replacement. `list_page_comments`
reads filtered threads separately. Legacy `read_page({page_id})` remains unbounded
for cached clients.

`read_page_changes({page_id,since_revision})` returns a complete net delta at one
captured revision: changed native nodes, address-only deletions, title changes,
and compact comment changes. Stable native identity avoids treating later
paragraphs as changed when an earlier one is inserted. An inserted or moved
block carries `before_node_id`, the block after it at the current revision
(null when last). An inserted, moved or deleted node carries
`before_node_id`, the next node that has an id: at the current revision for
an inserted or moved node, at the baseline for a deleted one, null when none
follows. Two nodes that have ids never name the same successor, so a caller
rebuilds the order of a block's nodes that have ids from its baseline and the
delta. A paragraph of unmarked text has no id and isn't placed among them; it
is reached through its block. Each change names its block's writers since the
baseline ([Edit writers](#edit-writers)). It is not an event/audit log and
does not supply deleted message bodies. A revision the host no longer knows returns `resync_required`; oversized
deltas return `changes_budget_exceeded`, never partial success. Advance a saved
revision only after consuming a successful response or resynchronizing with
focused reads.

Mutations require a `nonce`. Content edits also require the observed
`revision`, and so does a comment on selected text, which is located at it.
Other comment writes (a block comment, a reply, resolve, reopen, edit and
delete) take none. `delete_page` takes one as an optional guard. The default
`conflict_scope:"page"` requires the current revision. `edit_page` can use
`conflict_scope:"target"` for batches of only `replace_match`, `format_match`
and `set_node`, without `all`:
native identity maps
historical literal ranges into current text, checking text, marks, and structure.
A node's `node_id` narrows the match to that node; a block's matches anywhere in
it. Unrelated edits,
even within the same block, survive. Deleted/reinserted text is a new target;
overlapping batch targets are rejected. Structural/Markdown changes retain the
exact-revision guard. Conflicts provide bounded addresses for focused rereading.
Guards check the preparation snapshot; native changes can still merge during
persistence. Tool mutations do not simulate typing or lock out peers.

`replace_match` writes only the words that differ between the match and its
replacement ([`textSplices`](model/replace-match.mjs)): a word-token diff over
grapheme clusters (`Intl.Segmenter`), with each changed run narrowed by its
common prefix and suffix in whole clusters, so a combining accent, a ZWJ emoji
sequence or a flag pair is never split and never left as an anchor on its own.
A `match_text` that starts or ends inside a cluster is refused
(`invalid_edit_selector`), since the rest of that character would stay behind
with any anchor on it. Shared words keep their characters, so comment anchors
on them stay attached and a replacement equal to its match writes nothing. A word that changes
beyond a prefix or suffix is replaced whole, so an anchor ending in it detaches
and one starting in it shrinks to the words that remain. This is deliberately
not the character-level LCS `replace_block_markdown` gets from `updateSpans`,
which keeps stray letters and leaves an anchor on "table" attached to the "e"
of "desk". The diff has a budget of 2,000 token edits; past it the texts are
split at words unique to both sides and each piece is diffed alone, and a
piece that is still over budget refuses the edit with
`400 replace_match_too_large` instead of a coarse splice that would detach
anchors on words it kept. Inserted text carries the marks shared by the whole
match, plus any mark run that encloses its splice: a word replaced wholly
inside a code span, a link or a bold run keeps that mark, as retyping the
word would, and text inserted strictly inside a run continues it. Untouched
characters keep their own marks. A pure insertion at a run's boundary, or a
replacement that crosses a run's edge, does not spread the mark; when such a
mark covered only part of the match, the edit's entry and the receipt's
top-level `warnings` carry `marks_dropped` with the mark names and their
ranges as offsets into `match_text`, capped at 32 ranges (`ranges_truncated`),
so the caller can reapply them with `format_match`. A partial mark none of
whose words changed still covers them and is not reported. The agent caret
covers the changed words.

`replace_match` can take `replacement_markdown` instead of `replacement`: one
line of inline Markdown ([`parseInlineMarkdown`](model/markdown-import.mjs)). The
plain text goes through the same word diff, then the replaced range gets
exactly the written marks plus marks that covered the whole match; other
known marks are cleared from it and unknown ones kept. Written formatting is
explicit, so no `marks_dropped` warning is reported. Leading and trailing
spaces are kept outside the parse, since Markdown trims a paragraph.

Every passage operation takes a one-based `occurrence`, counted among the
matches context and `node_id` allow in the batch's starting snapshot.
[`applyOperation`](model/page.mjs) captures each one as cursors before any
operation runs, and the target-scope dry run follows the same cursors, so both
scopes agree. An occurrence an earlier operation changed is refused.
`format_match` also takes `all: true`: every non-overlapping match in the
block, at most 1,000, with matches in code blocks skipped and counted in
`skipped_in_code`. A batch writes formatting on at most 2,000 ranges, counting
each mark and each `replacement_markdown` run, refused before any mark is
written. `set_node`'s receipt carries only `matched` and, for `align`,
`cells`.

[`set_node`](model/set-node.mjs) changes the node that holds `match_text`,
as `{ type?, attrs? }` with the names [`model/node-registry.mjs`](model/node-registry.mjs)
declares and `read_page` reports: `type` (`paragraph` or `heading`, the
registry's `retype` group) and settable attrs (`level`, `language`, `checked`,
`align`, the last scoped to the table column). A top-level `checked`,
`language`, `heading_level` or `align` is refused with the field to use. It
rewrites the governing block marker through `updateSpans`, which updates the
marker's attributes in place, as the editor does: the marker, its text and
its comment anchors keep their identity. Marks on text characters are unchanged;
marks on marker characters, which format nothing, are dropped, as every editor
keystroke in the block already does. Inline embeds (hard breaks, images)
govern no text. In agent tools a quote's or list item's first paragraph is
addressed through the container's marker, so a type change there names the
quote or list item and is refused. In target scope a concurrent
change to the node's attributes is a `target_structure_changed` conflict, and a
`set_node` may share its passage with another operation.

### Unmarked text and node ids

Every node a writer writes opens with its marker, so it has a `node_id`, the
cursor on that marker. A merge can leave content no marker opens: one person
deletes a paragraph while another types or puts an image into it. Every
reader (the editor's decode, the agent read, node addresses and ids, the
Markdown projection, comment reads) reads it by one rule: content continues
the node before it in its scope when that node can hold it, and otherwise
opens a paragraph (in a table, a row and cell) with no marker. A code block
holds text and line breaks; every other textblock holds every inline node; a
leaf holds nothing. An embed of a type this build doesn't know that was
stored in a code block stays there as a notice. Such a paragraph reads with
`node_id` null; text-matching operations reach it, `node_id` operations
can't. Every host tool write to a block marks the block's unmarked text
in the same change, and the editor writes a person's typing or formatting
inside it through the encoder, which marks it.

A merge can also delete a container's marker (a quote, a list item, a table
or row) while a node a peer added inside it survives. Readers draw the
container from that node's `parents` and name it by that node's marker. No
writer restores the container's marker, so its `node_id` doesn't move.

### Parents no writer wrote

Sync admission doesn't look inside `richText`, so a block stores any marker
values a browser syncs. Every reader (decode, the agent read, node addresses
and ids, the Markdown projection, repair) draws any stored span sequence,
and none throws. A marker's `parents` is a list, and two writers that
change one marker's parents at once merge element by element into a list
neither wrote: a container repeated (`["table", "table"]`), or one that
can't hold what follows it. Every reader draws any `parents` by one rule (`nestIn` in
[model/wordgard-doc.mjs](model/wordgard-doc.mjs)): each parent, then the
node, nests in the nearest container before it that can hold it. A parent
nothing before it can hold is dropped, and so is a known name that isn't a
container (a rule, an image, a paragraph). A table row, cell or header nothing holds is
drawn inside the table (and row) it needs, which have no marker of their
own. A node marker's parents that aren't a list read as none.

Every reader converts a stored name, a type or a parent, through one total
function (`markerName` in [model/node-registry.mjs](model/node-registry.mjs)):
a string or ImmutableString is that name, and anything else (a map, whose
`toString` a peer can shadow) is no name. A type that isn't a name reads
as the notice with no name; a parent that isn't one reads as a container
this build doesn't know.

A mark is read the same way (`readMark` in
[model/wordgard-doc.mjs](model/wordgard-doc.mjs)): a known mark whose stored
value this build can't read, or must not render (a link to an unsafe URL, a
highlight outside the registry's colors), is a mark it doesn't know. The
editor keeps it as stored in `PagesForeignMarks` and encode writes it back;
every read draws it as nothing, so its value never reaches Markdown, an
outline, a card or HTML. A readable mark replaces a stored value of the
same name: bold applied over a stored `strong: "yes"` stores `strong:
true`, in the editor (`wordgardForeignMarks` in
[viewer/wordgard-binding.mjs](viewer/wordgard-binding.mjs)) and through
`format_match`. The foreign mark keeps its other entries, and removing
the readable mark brings nothing back.

`decode` reports two reasons a block can't be drawn as stored, apart:

- `newer`: content from a newer build. A node, container or embed name this
  build doesn't know, or a marker whose own values it can't read or must
  not render (`unreadableMarker`): a value or attrs that aren't a map, an
  image whose src is missing or unsafe, a heading level, table alignment or
  task state outside what this build writes, a dataframe it can't show.
  Every reader draws such a marker as the notice for a node it doesn't
  know; an unsafe src is never rendered or written as a URL, and encode
  writes the marker back as stored. An unknown container
  draws nothing in the editor and a notice in the agent read; where that
  makes the agent read's top-level nodes differ from the stored ones,
  `read_page` gives those nodes no `node_id`, so only the block's id
  addresses them. Nothing rewrites such a block, and the editor refuses a person's
  edit to one it draws only in part ("This block holds content from a newer
  version of Pages"). An owner removes such a node with `delete_node`
  when `read_page` gives it a `node_id`. When it reports none (an unknown
  node or unreadable dataframe followed by text that has no marker of its
  own), `delete_block` with the block's `node_id` removes the whole block;
  it works on any block. A
  marker with values this build can't read on a known node with a Markdown
  form (a heading level, an image) is also recovered by
  `replace_block_markdown`, which rewrites the block whole. That tool
  refuses a block holding an unknown node, an aside or a dataframe it
  can't keep, and its refusal names both recoveries. Editing text around
  such a node with `replace_match`, `format_match` or `set_node` works;
  text in the node itself answers `newer_content`.
- `adjusted`: every name is known, but `nestIn` re-homed a node or dropped
  or skipped a parent. Every reader draws one tree for the block, and
  `moved` lists each node marker whose drawn parents differ from its stored
  ones.

Reading is total; admission stays strict. Registration (`validateRich` in
[model/richtext-spans.mjs](model/richtext-spans.mjs)) and comment admission
(`validateRichSpans` and `isEditorForm` in
[model/comment-content.mjs](model/comment-content.mjs)) refuse a block or
message whose decode is `newer` or lossy, and every mark value outside the
registry, so nothing a reader would draw as a notice or as plain text is
admitted. No host tool writes into a node this build can't read, in page
scope and as passage targets; each answers `newer_content` (409):

- `replace_match` and `format_match` when the matched text is that
  node's own text (the text after its marker). A match never crosses a
  marker, and a notice is a marker, so the text's marker decides
  (`refuseUnreadableText` in
  [model/richtext-spans.mjs](model/richtext-spans.mjs)).
- `set_node` when the node it would change is one, or when the marker it
  would write has attributes or parents this build can't read.
- `set_image` when the image is one.

Text and marks in the nodes this build reads stay editable in a block that
also holds newer content. Those edits splice characters and marks and write
no marker. Repair leaves a `newer` and lossy block alone, so the match is
found in the stored spans: unmarked text stays unmarked (no node id), and
markers with adjusted nesting keep their stored parents. `delete_node`,
`delete_block` and `move_block` still work, and so does
`replace_block_markdown`, which replaces the block whole and refuses a
block holding a node it can't keep.

An aside (`PagesAside`) is a known container with no Markdown form. Any
synced client can store one; no agent tool or Markdown import writes one.
Pasted HTML from outside Pages makes none: the Page editor and the comment
composer replace each `<aside>` by its content (`unwrapPastedAsides` in
[viewer/clipboard-html.mjs](viewer/clipboard-html.mjs)), so its paragraphs
and lists land as ordinary blocks. An aside copied inside Pages carries
`data-pages-aside` and pastes back as an aside. A stored aside reads and
draws as before. Its Markdown is the
notice (`[Unsupported node: aside]`) followed by its content.

The Markdown serializer
([model/markdown-serializer.mjs](model/markdown-serializer.mjs)) never
throws. A block node it has no renderer for reads like an aside: the
notice, then its content. An inline leaf with no renderer reads as the
notice inline, and a mark with no Markdown projection reads as its text,
unmarked. Besides the stored markers above, `replace_block_markdown`
refuses a block holding anything else the serializer draws as a notice
(`noticeNode`, which renders the block), so a rewrite never turns a node
into literal notice text.

A block whose only problem is adjusted nesting is repaired, because storing
the drawn tree loses nothing a reader showed. Every host tool write to a
block runs `repairBlockMarkers`
([model/richtext-page.mjs](model/richtext-page.mjs)) first, in the same
change: each moved marker gets the parents it is drawn with, then unmarked
text gets its markers. The tree, the Markdown and the order of top-level
nodes stay as they were, and so does every `node_id` except a marker Automerge can't update in
place (the `updateBlock` fallback below), whose `node_id` changes. In the editor, a person's edit to such a block
is written through the encoder, which stores the tree the editor drew. A
container drawn with no marker of its own (a table around a row nothing
held, or a container a merge deleted) stays without one.

Every writer stores a block's spans through `updateSpansExactly`
([model/richtext-format.mjs](model/richtext-format.mjs)). Automerge 3.5's
`updateSpans` diffs a marker's `parents` in place, and a rewrite that changes
the parents of several markers can store a list other than the one given (a
table row's parents become `["table", "table"]` when the list around the
table loses its quote). `updateSpansExactly` runs `updateSpans` a second
time, which, over markers already of the right types, edits each list in
place and keeps every marker, so no `node_id` moves. A marker still wrong
after that is replaced with `updateBlock`, which deletes it and inserts a new
one: its `node_id` changes. No test or property run reaches that step.

Known limit: two repairs of the same adjusted block from one snapshot can
merge into adjusted nesting again (each inserts the same names into one
marker's parents list, as with a stray table cell). Markdown and node ids
stay as they were, and the next host write repairs it.

Known limit: two writers that mark the same unmarked text from the same
snapshot (a host write and a person's edit before either syncs) each insert
a marker, and both survive. The first opens an empty paragraph beside the
marked one. Every reader reads it, and a person (Backspace) or an agent
(`delete_node`) removes it.

### Link previews

Four browser routes tell a reader what a link to a Page or a Project shows
them ([`worker/link-previews.mjs`](worker/link-previews.mjs)). They are for
this origin's viewer; they're not tools and aren't in `/llms.txt`.

- `GET /p/<page_id>/meta.json`: `{ v: 1, page_id, title, state, role,
  content_updated_at }`. `state` is `active`, or `trashed` only for a reader
  who may restore the Page. No owner, members or ACL.
- `GET /p/<page_id>/card.json`: `{ v: 1, page_id, card }`, where `card` is
  the stored card `page_cards` reads, with the same `image` when both themes
  exist ([Card images](#card-images)), or `null` when the reader can open the
  Page but it has no card yet. The image route still decides as `page_cards`
  does, so a reader without a Catalog entry for the Page (a Project member, a
  company reader) gets the JSON card: the image's 404 leaves it showing.
- `GET /project/<project_id>/meta.json`: `{ v: 1, kind: "project",
  project_id, title, description, role }`. No owner, revision, members,
  times or content document ID. The record's update time is left out: it
  tracks title and membership changes, not content.
- `GET /project/<project_id>/card.json`: `{ v: 1, project_id, card }`, where
  `card` is the stored card of the Project's content document, with the same
  `image` shape, or `null`. A content document is an ordinary Page document,
  so its host writes a card beside a content flush, as for a Page: a new
  Project has none until its content is edited. The content document's card
  is read only after the Project admitted the reader. Its images follow the
  Page image route's rule, so a member who isn't the owner gets the JSON
  card.

Only these four paths, with a lowercase version 4 UUID for a Page and a
`prj_` or older `sp_` ID for a Project, and only GET and HEAD (other methods
get 405). The older `/s/<id>` Project route has no JSON routes; those paths
stay the app's. The caller authenticates as on other gateway routes: the
session cookie, or an Anaconda API key as a bearer; an MCP OAuth token and an
upload capability are refused. No credential is the same 401 for every ID. A
request whose `Sec-Fetch-Site` is present and neither `same-origin` nor
`none` gets 403 before authentication: a sibling deployment on the same site
sends this origin's cookie with its requests, and CORS alone would still let
it time the answers. A malformed ID, including a Page ID on a Project route
or the reverse, is refused before any host is asked.

For a Page, the target's Page host decides, from its stored record, through
the host-internal `/internal/link-preview` (the gateway never forwards a
client path there; `/internal/*` stays 404). The owner, direct grants,
Project members and company-domain readers all count, unlike `page_cards`,
which starts from the reader's own Catalog. The check claims no invitation
(a pending invitee is refused until they open the Page), records no usage or
presence, and writes no Catalog entry, title projection or index report. It
decides every refusal from the record without starting a boot itself, and
starts or waits for one only for a reader it admitted whose title the record
can't supply. Like every route, the first request to a cold host whose
record starts eagerly boots it in the constructor, and the shared request
cleanup may flush content activity earlier requests deferred. A Page whose
recovery is blocked answers as usual, as opening it read only does.

For a Project, the Project's host (the `Space` object, `spaces.mjs`) decides
from its record, through its read-only `/internal/space/read` with
`claim: false`, the check read_page breadcrumbs already use. It authenticates
the caller with their own credentials, reads the record, and answers only a
caller who may read the Project: its owner and its viewer, commenter and
editor members. With `claim: false` it claims no invitation (a pending
invitee is refused until they open the Project), writes no storage,
publishes no Catalog discovery hint and logs no usage line or invitation
event (authenticating an API key may still log its periodic acceptance line); asking
about a missing Project instantiates its object and stores nothing. No
Catalog is asked at all.

Every refusal of a kind answers one body:
`404 {"error":"Page unavailable","code":"page_unavailable"}` for a missing
Page, a malformed ID, a refusal, a deleted or purged Page, Trash (for anyone
who can't restore it) and a pending invitation, and
`404 {"error":"Project unavailable","code":"project_unavailable"}` for a
missing or malformed Project, a non-member, a revoked member and a pending
invitee. A host error or busy answer, an answer for another target, and a
timeout (the shared-Page check's bound) answer the same, so that answer
can't say why.

On a deployment behind a tunnel, these paths reach the Worker only when the
target's ingress admits them, `/project/<id>` forms included
(`linkPreviewPaths` in [routes.mjs](scripts/deployment/routes.mjs); see
[Gateway routes and the allowlist](DEPLOYMENT.md#gateway-routes-and-the-allowlist)).
Otherwise the edge answers an empty 404 without that code, and the hover card
reads it as a failure: "Couldn't load a preview", retried with backoff.

Every answer is `Cache-Control: private, no-store`, so a title or first
screen never stays in the browser's disk cache after sign-out.
There is no `ETag`: each look runs the access check again, and a revoked
reader is refused at the next one. Answers also carry
`Vary: Cookie, Authorization`, `Cross-Origin-Resource-Policy: same-origin`
and `nosniff`, and no CORS headers. The viewer's router reads all four paths
as missing, never as the Page or Project.

Both checks run in their host's serial request queue, so a burst of previews
waits behind edits to that Page or membership changes to that Project, and
the reverse. Each needs only its record; moving it out of the queue is a
follow-up before viewport loading raises the request volume.

### Refusal codes and tool hints

Every MCP refusal carries a stable `code`, in `structuredContent` and in the JSON
text, so agents never branch on message text. The Worker codes specific refusals
where they're raised: a stale exact-revision guard is `409 stale_revision`, a
malformed revision handle is `400 invalid_revision`, a missing `revision` and
an edit batch that can't apply (zero or multiple matches, an
unknown block, operation or mark) are `400 invalid_edit_selector`, a
`replace_match` whose change is past the diff budget with nothing to split it
on is `400 replace_match_too_large`, and a comment
action on a missing thread, message or block is `400 invalid_comment_selector`
(a `thread_ids` batch adds `not_found_thread_ids`). A full account is
`409 page_quota_exceeded` and a full Trash `409 trash_capacity`; both carry
`limit` and `count` (see Page quotas).
A Page at celld's per-cell request limit, or one Cloudflare reports overloaded,
is `503 page_busy` with `retryable: true` and `retry_after_ms`. A transient
Cloudflare failure between the gateway and an object is
`503 page_transient_failure`, retryable when the request is safe to repeat.
A listing that meets an unavailable shared Page is `503 shared_page_unavailable`
(see Request limits).
An MCP result has no HTTP status, so [mcp.mjs](mcp.mjs) names any refusal the
Worker left uncoded by its status (`access_denied`, `not_found`, `conflict` and
so on). It adds `retryable: true` to `stale_revision`, whose retry is a new request
built from a fresh read. The HTTP API keeps `retryable` for transient failures
only, because the browser treats those as an outage. A tool call that gets no
answer returns `read_failed` or `outcome_unknown`. `outcome_unknown` is
`retryable: true` only when the write carried a valid `nonce`, whose receipt
replays while it is kept; any other write gets `retryable: false` and is told to
read back and reconcile. The `/llms.txt`
guide lists the codes agents act on.

Every tool declares all four MCP annotation hints, and `tool()` refuses one that
doesn't, because clients read an absent hint as destructive and open-world.
Reads are read-only. Keyed writes are idempotent and not destructive: edits stay
in Automerge history. `delete_page`, `purge_page` and `delete_project` are destructive; Trash is
reversible, but it revokes every collaborator's access until restored.
`report_page_progress` is not idempotent because each call without a lease
starts another session. `create_page_asset_upload` is an ordinary write (it
needs write scope). It is open-world, because with `file` it downloads the
client's file, and idempotent: without `file` a repeat issues another
equivalent capability, and with it the same bytes reuse one asset.

### Agent carets

API agents get presence derived from the calls the host already authorized
([`model/agent-presence.mjs`](model/agent-presence.mjs)). A committed
`edit_page` publishes a caret where its last operation landed: a
selection over the text a `replace_match` or `format_match` changed, which the
browser fills for 600 ms before collapsing it to a caret, or a corner dot on a
block an operation inserted, moved or replaced. A `read_page` by section, search,
`node_ids` shows a reading bar; a search with one to three hits also
fills each hit. Whole-page and outline reads show nothing.

Targets are Automerge cursors captured inside the change, so they follow
concurrent typing. They travel in the `page-activity` snapshot and are never
written to the document, a receipt or the journal; a replayed receipt publishes
nothing. A caret is active for 15 s after a write, then fades, and disappears 60 s
after the agent's last call; a reading marker lasts 10 s. Each published entry
carries those times as `idle_at` and `expires_at`, and the browser applies them
on its own clock. The host prunes when it next reads or publishes the roster and
sets no timer for it: under celld a timer belongs to the request that set it and
keeps that request counted against the Page's per-cell request limit until it
fires (see [Request limits](#request-limits)). Only API credentials
(an API key or MCP OAuth) get presence: a browser sign-in session publishes
nothing, since that person's editor shows their own caret. A caret reads
"Kyle's Kilo · release agent": the account, the `x-pages-driver` harness and an
optional `x-pages-agent` session label. Labels sit under the authenticated
account and are trusted as such. Records key by account, harness and session
label, so two sessions of one account keep separate carets. MCP `initialize`
responses also carry an `Mcp-Session-Id`, and clients echo it; the transport
stays stateless. The worker turns the id into an account-scoped SHA-256 tag
(`identity.session`), so two unlabeled sessions on one credential still get two
carets and two colors, and the raw id never leaves the worker. MCP revision
2026-07-28 has no sessions: the worker ignores a client's `Mcp-Session-Id` and
builds the tag from the clientInfo each request declares in `_meta`
(`withModernMcpClient` in [usage.mjs](worker/usage.mjs)), so one account's
requests from one client name and version share a caret. A reading marker's
targets are captured on the revision the read returned.
Each participant's color comes from nteract's cursor palette, keyed by
principal and driver.

Comment and progress anchors are native cursors, so they skip the exact-revision
guard. Comments are written to the comments document, so a comment never
changes the Page's revision: the receipt's `revision` is the Page's, unchanged,
and `comment_revision` names the comments document's new revision.
`manage_page_comment` `add` with `selected_text` requires a known
`revision`, finds the passage (and `occurrence`) at that revision, and anchors
its cursors there. It returns `edit_conflict` only when the passage no longer
resolves, and `resync_required` for a revision the host no longer knows. A block
comment needs only its block. Replies, status changes, message edits and
deletions touch only the thread, so `revision` is optional and never compared. `resolve` and `reopen`
take `thread_id` or `thread_ids` (1–100 unique IDs), never both. A batch is one
Automerge change, one journal entry and one receipt, and `result.threads` gives
each thread's outcome: `resolved`, `already_resolved`, `reopened` or
`already_open`. A thread already in the target state is a no-op success and
keeps its status time. The batch is all-or-nothing. An unknown ID rejects it
with `invalid_comment_selector` and `not_found_thread_ids`, before anything is
written. Permission is the Page's comment access, the same check a single
resolve makes, so a denial also rejects the whole batch. `report_page_progress`
targets follow the same rule with `revision`, failing with
`presence_revision_changed` for an unknown revision or a detached passage. Retries
still replay the recorded receipt; these guards run only for new intents.

`edit_page` supports structural operations including `insert_markdown`,
`move_block`, and `insert_image`. Placement uses a block's `node_id` as
`after_node_id`, `null` to prepend, or omission to append; fractional positions
are internal. Content warnings, the ids in `result.edits`, and other receipt results are captured at
the operation's actual heads and are not recomputed during retry.

### Trash and permanent deletion

`delete_page` moves a Page to Trash; it does not delete the document. The Page
record keeps its Automerge document, comments, ACL, and signing-key bindings.
Trashing applies immediately, like an access reduction: member sessions close,
current viewers and editors get `403 page_trashed` (admission close 4410, retry
"recheck"), and their catalog references are pruned on their next listing.
Everyone else, including company viewers and removed members, gets exactly the
missing-Page response, `403 page_access_denied`. The D1 index retires trashed rows to the owner
and lists them only with `in_trash`. Index writes are fenced by the Page's
lifecycle revision, and every lifecycle transition advances the Catalog entry's
`updated_at`, so delayed retirements, reports and prunes cannot undo a restore. The owner keeps a
read-only preview through reads and sync; edits, comments, progress,
sharing changes, and image uploads return `409 page_trashed`. The browser
previews on a reader replica, so restore reloads onto the writer replica. An upload authorized
before trashing can still store its bytes before the final authorization check
rejects it; those bytes are unreferenced and are not cleaned up. Reads of a trashed Page carry a `trash` object.
The owner's catalog moves the entry from `page/` to
`trash/`, so trashed Pages leave default listings and the account's active Page
quota (see Page quotas).
`list_pages({in_trash:true})` lists them.

Each transition increments the record's `lifecycleRevision`. The Catalog
records the revision it last observed when it reserves a lifecycle request and
sends it as `expected_revision`; the Page applies the request only at that
revision. A retry of an older request returns its stored receipt, or
`{superseded: true, applied: false, state}` once that receipt has been pruned,
and never applies again. A superseded result was not applied; callers read the
current state before acting. The Page keeps its newest 256 receipts, each
stamped with the journal time; before it prunes older ones it raises the
receipt horizon to the newest pruned time, so a `delete_page` that names a
`revision` whose receipt is gone meets the fence. A guarded Trash whose
revision the host doesn't hold, or holds at or before the horizon, is
`409 resync_required`; one whose revision is known but not current is
`409 stale_revision`. A browser's Move to Trash sends the Automerge heads it
shows as `base_heads` in place of a revision, and a peer's edit since then
is `409 stale_revision`. Only a browser session (cookie) may send
`base_heads`; from any other credential it is `400 invalid_arguments`
([tool-arguments.mjs](worker/tool-arguments.mjs)). A
transition is committed with its receipt in one write and installed in memory
only after `sync()`; if that barrier fails, the next request finishes the
transition before doing anything else, so a receipt never replays for an
unfinished transition. If a newly reserved request is
superseded because the Catalog's index was stale, the Catalog retargets it once
at the Page's current revision. A Trash runs the leaf guard again first,
whatever the revision: the Page can have been trashed, restored and given a
child since the request was reserved. A refused or unsettled guard releases the
request, which the Page never recorded. The Catalog always projects the Page's
current state, not the replayed receipt.

The Page's side is one transition in
[page-lifecycle.mjs](worker/page-lifecycle.mjs), with its table in
[page-lifecycle.json](test/fixtures/machines/page-lifecycle.json). Its states
are missing, creating, active, trashing, trashed, restoring, purging, deleting
and deleted. Trashing, restoring and purging are commits whose sequence has
started and not finished; that phase lives only in memory, so a restart boots
from whichever record is durable. Deleting is a durable deleted record whose
deletion barriers have not run in this process. The lifecycle routes,
`/internal/lifecycle-state`, `/internal/tombstone` and the host's boot
(`bootHost`, run by page-startup) are its interpreter.

Pending trash and restore requests hold a hidden destination slot in the
owner's Catalog, written in the same storage call as the intent. The intent is
marked `forwarded` before the Page sees it. A never-forwarded slot counts for
one retry lifetime while its intent is pending. A forwarded slot does not
expire: once its lifetime lapses, counting asks the Page for its current
lifecycle state and either converts the slot to the real entry or releases it.
A resumed request whose slot lapsed takes a new one if capacity allows;
otherwise the Page only reports its current state. These rules, with the
retarget and the revision fence, are the
[operation-intent machine](worker/operation-intent.mjs). Its
[table](test/fixtures/machines/operation-intent.json) runs against the
transition and through the Catalog, which interprets it.

A trashed document that fails to load answers `503` and is retried on the next
request. Only a deleted record, or the owner Catalog's tombstone delivered to
the Page, makes the absence permanent; the Page then answers like a missing
Page. A tombstone answers only after its deleted record is durable. If that
write or sync fails, the next tombstone repeats it.

`restore_page` waits for the restored record to be durable, like an access
increase, then returns the same ID, content, comments, and ACL. Grants and key
generations are untouched by Trash, so collaborators reconnect with their
previous role and keys. Restored titles are projected back into member catalogs.
That projection runs after the restore commits. If the process dies in between,
a restart forgets it and a retried restore replays its receipt without
projecting, so members may not find the Page until its title projects again
([#4553](https://github.com/nteract/nteract/issues/4553)).

`purge_page` is a two-step owner operation on a trashed Page. `action:"preview"`
returns the title, comment count, collaborators who lose access, pending
invitations, and an HMAC-signed `preview_token` valid for ten minutes. The token
binds the owner, current heads, ACL, and lifecycle revision; any change
invalidates it. Confirmation rechecks the live heads and record in the same
synchronous step that tombstones the Page. While trashed, the policy refuses
sync writes from everyone, so only a change accepted before Trash and applied
late could differ. `action:"confirm"` with the unchanged token then runs the
permanent deletion path:
it tombstones the record and waits for it to be durable, then closes admission,
deletes the document, and writes the catalog deletion tombstone. With the
documents go the card objects and the uploaded images and datasets under
`pages/<page_id>/assets/`: as many as sixteen listing pages find, under a 10 s
deadline. That step is best-effort, like the card's: bytes it misses, or an
upload authorized before Trash that lands later, stay unreferenced, and no
deleted Page serves them.

Trash has no automatic expiry. Pages stay there until the owner restores or
purges them, up to 100 per account. Each trash record identifies its root Page.
This implementation trashes and restores individual Pages.

### Projects

A Project has its own ID (`prj_<uuid>`), title, description, owner, a members
ACL with a revision, a content document created with it (`document_id`) and a
tree of Pages. Results carry `org`, always `null` until a host supplies tenancy. The name matches the
organization → project hierarchy hosting platforms use for access, so a Project
can map one-to-one onto a host's project. Its Durable Object
([spaces.mjs](worker/spaces.mjs)) is the authority for that record.

Projects were called Spaces, and storage keeps that name so a rollback build
reads the same records: the `Space` class behind the `PROJECTS` binding,
`space/<id>` Catalog entries, `space_id` on Catalog location entries, journal
intents and receipts, and the D1 `pages_catalog_spaces` table and `space_id` column.
[project-api.mjs](worker/project-api.mjs) is the one place callers' names meet
storage's: it maps `project_id` and the Project tools in, and `space_id` out.
`create_space`, `list_spaces`, `get_space` and `update_space` answer
`tool_renamed`, and a `space_id` argument answers `argument_renamed`, before
anything runs. Projects created before the rename keep their `sp_<uuid>` IDs,
and `/s/<id>` links open `/project/<id>`. See
[DEPLOYMENT.md](DEPLOYMENT.md#projects-and-their-storage-identity).

The owner shares a Project with `manage_project_access`. Members inherit access
to every Page in it by role:

| Role | Pages in the Project | Add Pages | Share, move, Trash |
| --- | --- | --- | --- |
| owner | read, comment, edit | yes | yes |
| editor | read, comment, edit | yes | no |
| commenter | read, comment | no | no |
| viewer | read | no | no |

Every Page in a Project is owned by the Project owner and sits in the owner's
Catalog; inherited access ([project-access.mjs](worker/project-access.mjs))
depends on it. A Page an editor adds with `create_page` is no exception. It
counts against the owner's Page limit, and its Page record and Catalog entry
name the editor as `creator`. The editor's Catalog resolves the Project and its
owner, decides `create_items` against the Project's ACL, and forwards the
creation to the owner's Catalog with that ACL revision as a fence. The owner's
Catalog checks the fence and decides again before it reserves anything, so a
revoked or downgraded editor can't land a Page with a stale grant. A forwarding
record under the editor's own idempotency key names the owner-side creation, so
a retry resumes it rather than creating a second Page
([project-create.mjs](worker/project-create.mjs)). The Page host accepts an owner
other than its caller only while the owner's Catalog holds that Page's pending
entry with the caller as creator. Viewers and commenters are refused with
`403 project_create_forbidden`; a Project or parent the caller can't open still
looks missing. A Page with only a direct grant is shared as before and never
reveals its Project. `move_page` moves Pages into, out of and between the
owner's Projects; a Project change feed comes later.

The viewer lists them on two screens. `/projects` shows every Project
`list_projects` returns, with its description. The Pages library, at `/` and
`/pages` (one screen, two addresses), shows the Pages `list_pages` returns,
including Pages in Projects; an owned Page's row links its Project, and a
shared row never does. Its view lives in the address, defaults left out, so a
reload, Back and a shared link reproduce it
([routes.mjs](shared/routes.mjs) `normalizeLibraryView`):

| Parameter | Values | Effect |
| --- | --- | --- |
| `q` | text | `list_pages` `query`, trimmed and cut to its 200-unit limit |
| `show` | `owned`, `shared` | the Your items or Shared with you tab: `access` |
| `sort` | `title` | `sort: "title"`; omitted is Last activity |
| `project` | a Project ID | `project_id`; implies `show=owned`, dropped with `show=shared` (which `list_pages` refuses) |
| `group` | `project`, `date` | group sections over the loaded rows; `date` needs Last activity |

A choice pushes a history entry; typing a search replaces it; choosing what
already shows does nothing. `/` and `/pages` replace an address that isn't
canonical. Back and Forward between two library addresses hand the mounted
library its new view, so a grouping alone sends nothing and focus stays put.
Groups are a presentation over loaded rows
([library-groups.mjs](viewer/library-groups.mjs)): by Project (each Project,
Your items, Shared with you; the Source column goes, since the heading names
it) or by last activity (Today, Yesterday, Previous 7 days, Previous 30 days,
each month of the last year, then each year), in the order their first row
appears. Last activity is `content_updated_at`, else `updated_at`: the key the
Last activity sort orders by, so date groups follow the rows
([listing.mjs](viewer/listing.mjs) `activityAt`). Each group heading is a
disclosure button that folds its rows and keeps its count; Fold all and
Unfold all sit in the Group menu. Folds are this browser's, kept per account
and grouping by group key, so a Project folds by its ID and a rename keeps it
folded; Load more and rows that join a group later leave it folded
([library-folds.mjs](viewer/library-folds.mjs), at most 4 accounts and 100
folds each in `localStorage["nteract.pages.folds"]`). A heading's accent (a
bar, a faint tint and the label's color) comes from `groupAccent`: a Project
hashes its ID to one of six, Shared with you and On this device keep their
own, and date groups share one neutral accent whose bar fades with age. Each
accent reads at 4.5:1 or more in both themes, and the label still names the
group. The heading row, tabs and menus never move with the results: loading,
empty and failed views share one box in a body with a fixed floor, a new
request runs a bar along the control row and dims the rows it will replace,
and the page keeps its scrollbar's room. The Last activity column
shows the same time, and screen readers hear "Last active 2 days ago, …".
Drafts this browser hasn't synced show first, as "On this device", on All and
Your items when there is no Project filter. The server can't search them, so a
search keeps the drafts whose title holds it. When the listing fails, local
copies show there too. A `project` that `list_pages` refuses with
`project_not_found` reads "Unknown Project", with a button that clears the
filter; the account's Projects alone can't say so, since a Project created a
moment ago may not be in them yet. Load more follows
`next_cursor`; a cursor that has expired (`invalid_cursor`) starts the listing
over from its first page. The List/Grid toggle is always available. List is
the default, and this browser remembers the choice in `nteract.pages.view`.
Each grid card shows a preview of its Page's first content (see
[Card previews](#card-previews)). The `?grid=1` shortcut opens the tab on the
grid and remembers that choice; the library drops the query from its address,
and a reload keeps the chosen view. No `pages.grid` flag is needed.

### Card previews

A grid card shows a scaled, read-only rendering of the Page's first screen.
The Page host builds a `card.v1` bundle from its document
([page-card.mjs](model/page-card.mjs)): `{ v, card_hash, content_updated_at,
title, blocks, truncated, rich }`. `blocks` is
[page-preview.mjs](model/page-preview.mjs)'s JSON from its own `renderNode`,
never HTML, cut at 8 KiB serialized and 64 top-level nodes. A node that
doesn't fit is clipped to its leading children and text (a table keeps whole
rows), and the card ends there. A top-level node that shows nothing (no text, no
placeholder, rule or checkbox) is dropped, so an emptied Page has no blocks and
keeps the grid's icon. Images become a placeholder with their alt text, never
bytes or a URL; a dataframe becomes a placeholder with its title; links lose
their `href`; a code block names its language, so Mermaid stays code.
`card_hash` hashes `CARD_BUILDER_VERSION` and exactly the title, blocks and
`truncated`, so an edit below the fold changes nothing, and bumping the version
for a builder change rewrites each card on its Page's next flush. `rich` says
the card holds Mermaid, a dataframe or an image, which the JSON can only stand
in for; nothing reads it yet.

The card is written beside each content-activity flush and nowhere else
([page-card-writer.mjs](worker/page-card-writer.mjs)). A flush runs from a live
request on a booted host with its document loaded, at most once a minute, so
cards cost no new trigger, timer or alarm. The host stores the last written
hash under `host/card` and puts `pages/<page_id>/card.json` in the Page assets
bucket only when the hash changed; the stored hash follows the object, so a
crash between them writes the same card again. A failed write is logged and
retried by the next flush; it never fails the flush or the edit. A Page that
hasn't changed since cards shipped has none until its next edit, and the grid
keeps its icon.

Writes from different hosts of one Page are ordered by the object's etag. Each
put carries `onlyIf` with the etag the host last saw (none yet: only while no
object exists), and the object's `customMetadata` holds its `card_hash` and
`content_updated_at`. A host's first write after boot reads them (`head()`) and
compares the built card with the object, not `host/card`, so a stale card left
by an older host is rewritten. A retiring host's put that lands late carries
an etag the next host's write replaced, and the bucket refuses it. A refused
put reads the object again and retries once, unless the host stopped during
that read or the object's `content_updated_at` is later than the built card's:
then a newer host wrote it, and this host puts nothing, logs
`page_card.superseded`, and reads the object again on its next write. A first
write skips its put the same way. An object time more than 5 minutes
(`CONTENT_ACTIVITY_MAX_SKEW_MS`) ahead of the host's clock counts as missing,
as content activity drops it, so a card from a node whose clock ran fast never
blocks the writes after it. Equal times with different hashes still put, and
the later put wins: that is the same content built by two builder versions.

Two cases are left open. The order between live hosts comes from their clocks,
so it holds only within that 5-minute limit: an old host that is still live, on
a clock fast by less than that, can overwrite a newer card once. The newer
host's writes then skip until its own content times pass the old one's, so the
stale card can last until the next content change after that, however long
that takes, not just for the skew window. And a late
put can land after the next host's first write skipped an unchanged card: it
holds a card the Page had moments before, until the next change to its first
screen.

A purge or tombstone deletes the object and `host/card` with the content time,
waiting at most 2 seconds on the bucket; a missed delete leaves an object
`page_cards` never serves, since a deleted Page admits no one. A write still
running then deletes the object again when it ends, whether its put landed or
timed out. A host that retires without a deletion (an abandoned boot, a storage
migration) stops its writer and leaves the object and `host/card`, which the
next host, plain or native, compares against. Trash keeps the card on purpose:
`page_cards` answers `null` while the Page is trashed, and a restore shows the
card at once rather than after the next edit.

`page_cards` (`/api/tools` only) takes up to 24 `page_ids`
([page-cards.mjs](worker/page-cards.mjs)). The caller's Catalog decides access
inside its serial queue with `list_pages`' rules: an owned ID needs a settled
`page/<id>` entry (so a trashed Page has none), and a shared ID needs a
`shared/<id>` entry and a fresh `verifyShared` by its Page host, the metadata
check that doesn't boot the document, finding the Page active. D1 is never
read. The Catalog answers only the allowed IDs, and the gateway reads their
objects after the queue has moved on, all at once under one 1.2-second
deadline, so a slow bucket never holds the account's listings, creates or
reports. Only allowed IDs reach the bucket, and no object URL leaves the Worker.
Every other ID, unknown, refused, unchecked in time, read too late or without a
card, answers `null`, so a caller can't tell "no access" from "no card". The
answer names its `principal`. It isn't an MCP tool: an agent can read the Page
itself, and a card is a drawing aid shaped for the grid, not a reading surface
worth a stable contract.

In grid mode each card asks for its card when it comes within 400px of the
viewport ([page-cards.mjs](viewer/page-cards.mjs)). A card that asks waits at
most 200 ms for others to share its request, counted from the first card
waiting, and 24 waiting cards go out at once, so a steady scroll keeps loading
while it runs: with a 150 ms round trip, every card shows within 350 ms of
coming into view. At most two requests run at once, and a request takes the
latest cards to come into view first. A card that leaves the viewport, or
unmounts, before its request goes out stops waiting and goes back to idle, so a
request never carries a card that left view before it went out. A request with room fills toward 24
with the next cards in the grid's order that haven't asked, so a slow scroll
down a 100-card grid sends 5 requests, not one per row. Each card follows a small
machine, `idle → requested → shown | empty | failed`, keyed by Page ID and the
row's `content_updated_at`, so a Page edited since the grid asked asks again; a
failed card asks again when it scrolls back in. One answer is one store update.
The machines live as long as the mounted grid, with no cross-visit cache; a grid
that doesn't know its account asks for nothing, and an answer naming another
account is ignored. [PageCardPreview.jsx](viewer/PageCardPreview.jsx) draws the
card through PagePreview's allowlist in its inert mode (no links, controls or
images), laid out at a reading width and scaled with `transform: scale()`,
`aria-hidden` with pointer events off: the card's link carries the title.

A library visit sends one `list_pages`, for its view. `list_projects` is one
request per account shared by the Project filter, the Browse picker, Move to…
and the first page of `/projects`; a request made while one is in flight joins
it ([project-list.mjs](viewer/project-list.mjs)), and an answer that names
another account (`principal`) never shows as this one's and rechecks the
session, as a library or picker answer for another account does; one that names no
account, from an older API, shows but isn't kept past a failed refresh, just
as the listing cache never stores a page that names no account. The first page of each view
this tab has shown stays in memory, keyed by account and request
([listing-cache.mjs](viewer/listing-cache.mjs)), so a return visit, Back from
a Page included, paints it while the listing asks again. A page is kept only
under the account that answered it (`list_pages` returns its `principal`),
and paints for 5 minutes after it was shown: after that, shared titles wait
for their Page hosts again and the view shows Loading…. A refresh that fails
lists nothing rather than the remembered rows. The cache and Projects are
cleared on sign-out, account change and any tool call refused with a 401.
A 401 also starts a recovery
([signed-out-recovery.mjs](viewer/signed-out-recovery.mjs)): it rechecks the
session and, if the same account answers, asks for its Projects again. An
answer for another account starts the same recovery without forgetting
anything. One recovery runs at a time; a 401 or another account's answer
during it runs it once more when it settles, at most twice in a row, so a
server that keeps refusing, or keeps answering for someone else, can't loop
the tab. The cache overlays a rename this tab saw, forgets a Page
moved to Trash or hidden by its host, drops the views of the account's own
Pages after a create, move or restore, and is never persisted. Each patch
moves the cache's revision, and a reply whose request began under an older
one isn't written back, so a listing in flight across a create can't restore
what it dropped. The Browse picker
([picker-walk.mjs](viewer/picker-walk.mjs)) walks every Page (`list_pages`
cursors, at most ten requests) afresh each time it opens, for the signed-in
account only. Closing it aborts the request in flight, whose answer, a 401
included, then counts for nothing. A sign-out or account change closes it; a
401 drops its rows and leaves it open saying why, until the session check
closes it or the person reopens it. Neither walks again, so a 401 can't start
another walk. A walk answered for another account, or whose pages name
different accounts, rechecks the session; when that recovery ends with the
same account, the picker says to reopen it and try again.
A Project's content, read with `project_id`, lists its Project. An open Page
asks `read_page` where it is until it is found: it asks again each time a Page
created in this tab registers or the session reconnects, and a transient
failure also retries after 2, 4 and 8 seconds. Once found, it stops asking.
Move to… hides on a Project's content, asks when chosen otherwise, and on a
draft that hasn't registered says to wait for it to sync.

| Tool | Arguments | Result |
| --- | --- | --- |
| `create_project` | `title`, `description?`, `nonce` | `project_id`, `title`, `description`, `revision`, `role`, `owner`, `url`, `document_id` |
| `list_projects` | `cursor?`, `limit?` | Projects with the same fields as `get_project`, `next_cursor` |
| `get_project` | `project_id` | `project_id`, `title`, `description`, `revision`, `role`, `owner`, `url`, `document_id` |
| `update_project` | `project_id`, `title?`, `description?`, `expected_revision`, `nonce` | the updated Project, or `superseded` |
| `delete_project` | `project_id`, `action` (`preview` or `confirm`), `preview_token` (confirm), `nonce` (confirm) | preview: `title`, `collaborators`, `pending_invitations`, `comment_count`, `preview_token`; confirm: `{ project_id, deleted: true }` |
| `create_page` | adds `project_id?`, `parent_id?` | adds `project_id`, `parent_id` (`null` at the top level) |
| `list_pages` | adds `project_id?`, `parent_id?` (`null` = top level), `kind?` | owned rows add `project_id`, `parent_id`, `position`; never the content document |
| `read_page` and every other tool taking `page_id` | `project_id` in place of `page_id` addresses the Project's content (exactly one; both is `invalid_arguments`) | adds `kind` (`page` or `project`), `project_id`, `parent_id`, `breadcrumbs`; content reads carry its `page_id` (= `document_id`) |
| `move_page` | `page_id`, `parent_id`, `position?`, `nonce` | `page_id`, `project_id`, `parent_id`, `position`, `location_revision`, `descendants`, `trashed_descendants` |

Every Project and item operation goes through the caller's own Catalog, which
calls the Project and Pages with the caller's credentials. A Project never calls a
Catalog or a Page. `create_project` reserves a journal intent with the Project ID
and content document ID first, then creates the Project record and the content
document; both steps are idempotent, so retrying the same token, key and
payload after a crash or lost response, within the token's window, finishes the
same Project. A retry without the token is best-effort. Until then `get_project`
answers `project_pending` and `list_projects` omits it. The content holds
orientation and guidance for people and agents. It is ordinary, untrusted
document content, edited with the Page tools by `project_id`; it is not a Page in
the tree, so `move_page`, `delete_page`, `restore_page` and `purge_page` refuse it
(`project_content_protected`), and `list_pages` never lists it. A direct grant on
the content document (by its `document_id`) opens it as a plain Page, `kind:
"page"`, without revealing the Project.

The owner's Catalog is the only record of where a Page is
([catalog-location.mjs](worker/catalog-location.mjs)); Page records carry no
location. Each owned entry stores `parent_id` and `position`. A root in a
Project stores the Project's `space_id` with `parent_id: null`; the content
document's entry stores `project_content` and no location; a sub-page's Project
is derived by walking parents to its root with
[model/location.mjs](model/location.mjs). The Catalog stamps its location shape
version (`LOCATION_SHAPE_VERSION`, now 2); this build reads only that shape.
`create_page` writes the location
into the pending Catalog entry in the same put as its journal intent, so a
retry finds its parent there, and the Page learns only its content. Results
call `space_id` `project_id`. A parent implies its Project; a different
`project_id` is `placement_mismatch`. Pages nest at most 9 levels (`nesting_depth_exceeded`), and
only Pages the caller owns can hold sub-pages in this build. Project and Page IDs
have different shapes, so a swapped ID is a structural error
(`project_id_as_page_id`, `page_id_as_project_id`) that names the right tool and
argument and reveals nothing about either resource.

Listing by Project or parent reads the Catalog's entries, not D1: a Project
lists every descendant of its roots, and a parent lists its direct children.
Children of a parent shared with the caller come from the parent owner's
Catalog, and each is verified by its Page host with the caller's access. One
request checks at most 100 of them. Past that, a sealed cursor continues from
the last child checked, even on a short page, so the caller can learn only that
the parent has more than 100 children.
`list_projects` takes candidates from `pages_catalog_spaces` and confirms each
against the owner's `space/<id>` Catalog entry; cursors are sealed to the
listing's filters. `read_page` breadcrumbs are computed in the gateway with one
call to the owner's Catalog, a host-only `/internal/location` route that answers
ancestor IDs and the root's Project and nothing else. Each ancestor and the
Project then answer with the caller's credentials, so the trail stops at the
first Page the caller cannot open and `project_id` appears only when the
Project is readable.

`move_page` reparents or reorders an owned Page in one Catalog write
([move-page.mjs](worker/move-page.mjs)): the moved entry's `parent_id` and
`position`, any destination siblings rekeyed to repair ties or rebalance long
keys, `host/location/revision`, the completed journal row with its receipt and
the index's dirty mark go in one transaction (several puts when a rebalance
passes 128 keys). No Page is called and no heads change; the subtree, trashed
descendants included, follows its root. The request is a state machine
(`received`, `settling`, `planning`, `writing`, `replied`, `refused`): it
replays a completed receipt, settles the Page's and the parent's Trash or
restore reservations within the lifecycle budget (`lifecycle_unsettled` when
out of it), runs the shape pass like every queued write, then `planMove`
([model/location.mjs](model/location.mjs)). A destination is a
`parent_id`, a `project_id` (the Project's top level, `parent_id: null`), or
`project_id: null` (a root in Your items), and a Page moves within its
container or across them: Your items into a Project, a Project out to Your
items, or one Project to another. Only a request naming no destination answers
`move_destination_required`. Project membership grants inherited access.
Moves across a Project boundary with current or historical sharing are refused
with `shared_project_move_unsupported`; moves within that Project remain
available. Direct Page grants remain separate. A failed
barrier after the put is `503 move_unconfirmed`; the retry replays the receipt
or plans again over what is stored and reports where the Page landed.

Trash stays single-Page. `delete_page` on a Page with active sub-pages, or
sub-pages still being created, returns `page_has_children`; trash the sub-pages
first. Subtree Trash is not available yet: it will return on an explicit
operation intent with per-item fences and capacity reservations. A restored Page
whose parent is in Trash or gone returns to the top level of its Project (or Your
items); a sub-page's Trash entry records its Project (`restore_space_id`) for
when the parent is purged. The Catalog decides this when it projects the
restore. Creating a Page under a parent in
Trash returns `parent_unavailable`, including a resumed creation, which checks
its parent again before it reaches the Page.

Placement decisions never trust a Catalog entry with an unsettled Trash or
restore reservation: a lost response or failed barrier can hide a transition the
Page already applied. Restore reservations record the Project and parent the Page
returns to. Before the leaf check or a restore placement reads such an entry,
the Catalog asks the Page for its lifecycle (`/internal/lifecycle-state`) and
projects an applied transition. A child whose restore applied counts as a child.
A parent with any Trash entry, or a pending Trash reservation, is unavailable,
so a restored child goes to the top level even if that trash has not applied
yet. When the Page can't answer, the request is refused with
`lifecycle_unsettled` (retryable) rather than decided on a guess. Every Catalog
request shares one queue, so these reads are bounded: each read (fetch and body)
gets 2 s, one pass gets 5 s with no read starting after its deadline, and an
exhausted budget also returns `lifecycle_unsettled`. Reads are shared across
passes: a pass reuses the read in flight for the same Page, and at most four
underlying reads run at once, counted until they settle rather than until a
caller stops waiting. Each read is aborted at 2 s; celld 0.6.3 honors an
AbortSignal on a Durable Object stub fetch, and the body is read through a
reader the abort cancels, since an abort after the headers does not interrupt
a body read. A resumed trash that lost its reservation never applied,
so before it re-acquires one it asks the Page: if the Page's lifecycle has not
moved, the leaf guard runs again and a child created meanwhile refuses it; if it
has, forwarding replays a recorded receipt or comes back superseded, and a
superseded Trash meets the guard again before it may retarget.

Catalog and Space objects each run one request at a time through
[serial-queue.mjs](worker/serial-queue.mjs). Not every await inside a request
has its own deadline: Page and Space fetches and credential checks do not. So
the queue has a watchdog. When the running request reaches 120 s, the object
resets through `ctx.abort()`, which celld 0.6.3 supports, and the next request
reaches a fresh instance. The running request's timer catches it, and so does
the next request to arrive, which checks the running request's age. Requests
already queued on the reset instance never settle, and their callers' 60 s
deadlines answer them. A Page's title projection has no gateway deadline, so
the Page gives it 10 s. On a timeout the Page forgets the title it sent, and
the next request to the Page sends it again. Reset is safe here because Catalog and Space state is
all in durable storage, and their operations recover from a restart through
stored operation intents. The log line has stage `catalog-queue` or
`space-queue`, status 503 and reason `request_timeout`. Pages don't use this
queue: a Page holds live document state and sockets.

celld 0.6.3 cancels a Durable Object request when its caller goes away: the
client of the gateway request that forwarded it disconnects, such as a tab
navigating away while its listing is in flight, or the calling object aborts
its stub fetch. The object request's pending timers and I/O are dropped and its
promise never settles. A request still waiting in a queue starts in that dead
context when its turn comes. Either way it holds the queue: a Catalog or Space
until the 120 s watchdog, a Page until the object is
discarded. So each of those objects passes every request to `ctx.waitUntil`
when it queues it, through [request-hold.mjs](worker/request-hold.mjs). A
Page's `/api/saved` and `/api/sync` skip its queue but are held the same way: a
save waits for heads and drains the record store's serialized flush, and a
sync's resident socket already holds its own request. A Catalog also holds the
lifecycle reads that later requests reuse. A catalog index migration attempt
belongs to the object that started it, and its callers stop waiting after 1.5
or 2.5 s, so `catalogIndexDatabase(env, ctx)` requires the caller's `ctx` and
holds the attempt on it; no Catalog or Page call site can skip the hold. The
work runs to completion after its caller leaves, and its response is
discarded. Objects share only a settled result (see
[Catalog index](#catalog-index)).

A continuation inside a Durable Object runs under the request that started the
code awaiting, not the one that settled the promise, and celld 0.6.3 drops the
timers and I/O started there once that request has responded and its
`waitUntil` work has settled. A long-lived loop started by one request, such as
automerge-repo's scheduler loop that delivers a document's `change` events,
keeps that request's context for good. Storage writes from it may land, but a
fetch, a D1 query or a timer started from it never settles, and nothing logs.
So a listener on a document handle must not start I/O: it records what it saw,
and a live request runs the work, as content activity does
(worker/content-activity.mjs).

`update_project` requires `expected_revision`. The Catalog records it in the
journal intent before the Project sees the request, and every attempt carries it,
so a retry can never apply once the Project has moved past that revision, even
after the Project evicted the key's receipt (it keeps the latest 64). Such a retry
returns `superseded: true, applied: false` with the current Project.

`delete_project` permanently deletes a Project its owner no longer needs.
Anyone else is refused as for `update_project`: a member with `403`, everyone
else with `project_not_found`. A Project that still holds a Page, active,
being created or in Trash, is refused with `project_not_empty`; deleting a
Project never deletes a Page. It follows `purge_page`'s two steps.
`action:"preview"` reserves nothing and returns the Project's title,
collaborators, pending invitations, its content's comment count and heads,
and a `preview_token` the Space signs, valid for ten minutes. The token binds
the owner, the Project's revision and ACL, and the heads of the content and of
its comments document.
`action:"confirm"` with that token runs one journal intent through the
[space-deletion machine](worker/space-lifecycle.mjs), whose
[table](test/fixtures/machines/space-deletion.json) is its contract. Each
phase is persisted before the next effect, so an exact retry resumes it and,
once done, replays `{ project_id, deleted: true }`:

1. The Catalog checks again that the Project holds no Page and reads the
   current heads of the content and its comments document. The Space checks
   the token against its live record and those heads; a valid token records
   the deletion in the same step. From then on the Space answers every route
   like a missing Project, so members' inherited access, invitation claims
   and Project reads stop. A refused token releases the key with
   `purge_preview_invalid`.
2. The Catalog trashes the content document with those heads as
   `base_heads` and `base_comment_heads`, so the Page compares both in the
   step that refuses further writes. Only this trash sends
   `base_comment_heads`: the Catalog drops it from a caller's `delete_page`.
   An edit or comment that landed after the preview (the owner still owns the
   content, and members' leases last 15 s) reopens the Space and the request
   is refused with `purge_preview_invalid`.
3. The Catalog purges the content document through the Page's permanent
   deletion path, at the revision the trash reported: its content and
   comments documents, card objects and uploaded assets go.
4. The Catalog writes the content's deletion tombstone, removes its `page/`
   and `space/` entries and marks its D1 rows; the next `list_projects`
   rewrites `pages_catalog_spaces`.
5. The Space removes members' discovery hints and its
   `pages_project_invitations` rows, then every key it stores. The receipt is
   recorded after that.

A Project whose content record is in a format this build doesn't write
(including `pages.page` 2, and a record with no `documentFormats` stamp) is
deleted from that record, as Trash and purge delete such a Page: nothing
opens or decodes its documents. Its preview reports
`comment_threads` and `comment_count` as `null`, and the token binds the
content record's lifecycle revision in their place; through this build no
one can change documents it doesn't open. The deletion's trash then applies
only while the host still doesn't open them. A host that opens them by then
(a build that writes their format) is a change since the preview, so the
Space reopens and the request is refused with `purge_preview_invalid`. The
token always binds that revision too.

While a deletion is unfinished, the owner's listings and reads already treat
the Project as missing, and a preview with a new key is `project_not_found`;
only a retry of the same request finishes it.

### Card images

The JSON card can't draw a diagram, a table's rows or highlighted code. The
Page owner's own browser can, so it draws them. Other tabs do nothing:
[card-capture.mjs](viewer/card-capture.mjs) starts only once the session
shows the owner's write access. While the owner's tab is visible, it rebuilds
the card's `card_hash` from its local document with the host's code. When
that hash differs from the stored image's, it waits for 3 s with no edit or
input (pointer, key, wheel or scroll), then renders the card's blocks
read-only. The renderer
([card-shell.mjs](viewer/card-shell.mjs)) uses the editor's own widgets in a
hidden same-origin iframe, light and dark. It rasterizes them with
`modern-screenshot`, a lazy chunk loaded on the first capture, at
640×480 CSS px and 2x. It uploads WebP, or PNG where the browser has no WebP
encoder (Safari). A capture starts at most once every two minutes, never on
Save-Data or under 2 GB of device memory, and never runs beside another one. A
changed first screen, a hidden tab or leaving the Page cancels it. Input
cancels it too, and the cancelled capture doesn't count against the
two-minute rest. The tab
learns the stored hash from one `GET /api/pages/:id/card-image` when the Page
opens, then from each upload's answer.

`PUT /api/pages/:id/card-image?hash=&theme=` admits only the Page owner, by the
Page host's own policy ([card-images.mjs](worker/card-images.mjs)). The bytes
must be a static WebP, PNG or JPEG of at most 300 KB, never SVG. `hash` must be
the `card_hash` of the host's loaded document, and each theme uploads at most
once a minute. The host numbers each admitted upload from its durable storage.
The images live at `pages/<id>/card/<hash>-<theme>.<ext>`. An etag-fenced
`card/latest` pointer names the current hash and the highest revision it has
seen. A swap to another hash with a lower revision is refused as stale, so an
upload for an older first screen that lands late can't replace a newer one.
The pointer references at most one image per theme, not a bound on stored bytes.
A stale upload retains its image key because a newer accepted upload may already
reuse that hash/theme key. Rejected uploads and failed writes or deletes can leave
orphaned bytes. Successful swaps still attempt to delete old images; that separate,
unfenced cleanup can race with newer uploads reusing those keys.
`page_cards` adds `image: { card_hash, light, dark }` only when the pointer's
hash is the stored JSON card's and both themes exist. The image route decides
access as `page_cards` does, on every request: the caller's own Catalog entry
for an owned Page, or its shared entry plus the Page host's record-only check.
A grid of image cards boots no Page document, and a revoked grant fails on
the next fetch. Its responses are `private, immutable`
and carry `nosniff`. Purge and tombstone delete `card.json`, the image pointer and
its referenced images, plus orphans found in at most four prefix-listing pages.
That bounded cleanup may leave orphaned bytes beyond the listing limit.
The server can't check that the pixels match the content. That is the trust of
any image the owner inserts into the Page, and only the Page's readers see it.

On a deployment behind a tunnel, `GET` and `PUT /api/pages/:id/card-image` and
the image paths reach the Worker only when the target's ingress admits them
(`cardImagePaths` in [routes.mjs](scripts/deployment/routes.mjs), file names
exactly as `CARD_IMAGE_FILE` names them; see
[Gateway routes and the allowlist](DEPLOYMENT.md#gateway-routes-and-the-allowlist)).
Otherwise the edge answers an empty 404: the owner's tab stops at the stored
hash read and uploads nothing, and the grid keeps showing JSON cards.

### Retry contract

After a conflict, reread before constructing new work. For an uncertain outcome,
retry the **identical nonce and payload** from the same account. Every agent
write takes a `nonce`, the caller's own: 6–64 letters, digits, `_` or `-`
(`^[A-Za-z0-9_-]{6,64}$`), a new UUID for each new operation. Anything else is
`400 invalid_nonce`. The host keys the receipt by the caller's principal, the
receipt lane and the nonce:

```
host/operation/n1_<first 32 hex of sha256(principal)>_<lane>_<nonce>
```

Lanes keep one account's writes of different kinds apart on one object: `page`
for edits, `comments` for comment writes, `catalog`, `project`,
`project-access`, `page-access` and `lifecycle`. A Page stores its lifecycle
receipts (trash, restore, purge) under `host/lifecycle/` and a Space its
receipts under `host/receipt/`, each with the same name after the prefix.
Another account's identical nonce is another request. The same nonce with a
different payload is `409 nonce_conflict` ("This nonce was used for a
different request"). `purge_page` and `delete_project` keep their
`preview_token`, which binds the confirm to what the preview showed.

#### Revision handles

Agents never see Automerge heads. A read, receipt or refusal names a Page
document revision as `r<n>`, a comments document revision as `c<n>` and a
sources document revision as `s<n>` ([revisions.mjs](worker/revisions.mjs));
the letters come from the host's type modules. Results carry `revision`,
`comment_revision` and, once the Page has sources, `sources_revision`;
revision refusals (`stale_revision`, `edit_conflict`,
`resync_required`) carry `current_revision` and `comment_revision`; a
target-scoped edit's `concurrency` is `{rebased, base_revision,
observed_revision}`. Arguments are `revision`, `since_revision` and
`since_comment_revision`. A malformed handle, or one with the other document's
letter, is `400 invalid_revision`; a well-formed handle the host doesn't hold is
`409 resync_required`. Browsers, sync and host-to-host calls keep heads.

Each document's host keeps a counter, its latest handle and a table:

| Key | Value |
| --- | --- |
| `host/revision/<doc>/counter` | the last number minted |
| `host/revision/<doc>/latest` | `{ n, heads, at }` of that number |
| `host/revision/<doc>/h/<n>` | `{ heads, at }`, `n` zero-padded to 16 digits |

`<doc>` is `page`, `comments` or `sources`. Minting writes all three in one put, and a
handle reaches a caller only after a sync barrier. Heads that equal the latest
handle's reuse it while that handle is newer than the receipt horizon; otherwise
the host mints the next number, so a read never hands out a handle the fence
refuses. A new handle's `at` is the journal time and at least the horizon plus
one. The table keeps the newest 2,000 handles per document and
never drops the latest. A write mints its handles in the same put as its
pending journal entry, so the receipt and its handles exist together. A read
that meets heads with no handle mints one: `read_page`, `list_page_comments`
and `read_page_changes` write one batched put and sync when they do, and so does
turning a revision refusal into `current_revision`. `read_page_presence` names
no revision and writes nothing.

#### Receipts and the fence

The journal keeps one receipt lane of 1,000 entries/8 MiB, with pending work
bounded separately at 64 entries/4 MiB. Each receipt gets `recordedAt` from the
host's journal time: the wall clock, never below the receipt horizon or the
`at` of either document's latest handle, so a stepped-back clock can't stamp
a receipt behind one already recorded. Collection deletes completed receipts
older than `RECEIPT_LIFETIME_MS` (seven days). At capacity a new write evicts
the oldest completed receipts (by `recordedAt`, then by key). Only pending
entries make the journal refuse, with `429 operation_receipt_capacity` or
`pending_operation_capacity`. Pending entries are never collected, and an
interrupted write resumes with its original request: the journal persists the
causal base and encoded changes first, then replays identical CRDT change IDs.

Forgetting a receipt is allowed; running an uncertain request again on the
strength of a forgotten one is not. Before it deletes receipts, the journal
raises the horizon (`host/receipt-horizon`) to the newest `recordedAt` among
them and makes it durable. The horizon is never less than the clock minus seven
days. A write that names a revision is fenced: when no receipt answers it, a
handle the host doesn't hold, or one minted at or before the horizon, is
`409 resync_required`. A receipt for a write made against that handle may be
gone, so the host refuses rather than guess whether it is a retry. Receipt
replay comes first. The fence covers `edit_page` in both scopes, a passage
comment and `delete_page` with `revision`; it has no exemption for the
latest handle and doesn't look at the handle after it.

A write that names no revision has no fence. `create_page`, `create_project`,
`move_page`, `restore_page`, `delete_page` without its optional `revision`, and
comment writes other than a passage comment run again as new requests once
their receipt is gone. Writes that carry an `expected_revision` (sharing,
`update_project`) still meet that check. A retry returns its receipt while the
host still holds it: up to seven days, and capacity can shorten that. A client
that lost the response to a write without a revision reads, then decides
whether to send it again. Browser edits consume no receipts. Catalog deletion
tombstones remain permanent; Trash writes none. See the
[operation journal](worker/operation-journal.mjs) and its tests
([unit](worker/operation-journal.test.mjs), [capacity](worker/receipt-capacity.test.mjs)).

### Page tags

A Page carries a set of tags: short, lowercase, freeform labels that agents set
on their own work and other agents search. Tags mean nothing to Pages and grant
no access, and anyone who can see a Page sees its tags. They are rows in the D1
table `page_tags` (`page_id`, `tag`, `added_by`, `added_at`; primary key
`(page_id, tag)`, plus a lookup index on `(tag, page_id)`), created by its own migration
list (`PAGE_TAGS_MIGRATIONS`), recorded in its own version table, `page_tags_schema`.
They are not in the Page's Automerge document, so changing them never moves its revision, and a document restore or export does not carry them.

**Source of truth.** `page_tags` is the single normative record of a Page's
tags. It is not an index and not a projection. No Durable Object, Page host
record, Catalog entry or document holds a copy, so there is nothing to rebuild
it from, and there is no Durable Object for tags and none planned: tags have no
real-time part, and a REST-style write plus a searchable read is all they need.
D1 is the only place that can search tags across Pages, so it is also where they
live. This differs from the `pages_catalog_*` tables, which project each
account's Catalog and Page host Durable Objects into D1 for listing
([Catalog index](#catalog-index)) and can be cleared and rebuilt. The table
shares D1's database with them, but not their migration chain or their rules: its
schema versions live in `page_tags_schema`, apart from `pages_catalog_schema`, so a
change to the catalog's migrations can't reset or renumber it.
Nothing clears or rebuilds `page_tags`: not reconciliation, not a cooled index,
not a migration that resets `pages_catalog_accounts`. Only a Page's permanent
deletion deletes its rows, and the Page host does that itself
(`deletePageTags`, after the catalog tombstone is written), whether or not
`PAGES_CATALOG_INDEX` is set: the tombstone is a projection and never touches
the table. If D1 fails the delete, the purge step fails and the lifecycle repeats
it. Trash keeps them, hidden with the Page; restore brings them back. The Page host decides who may edit and
holds no tag state. The read and write code is in
[page-tags-store.mjs](worker/page-tags-store.mjs); the projection supplies only
candidate Pages, and the table decides which candidates match. On a celld target
D1 and each Page's storage sit under the same versioned fleet prefix, so the
restore points in [DEPLOYMENT.md](DEPLOYMENT.md#restore-points) cover both for 14
days. Past that, nothing can rebuild tags. See
[Where state lives](DEPLOYMENT.md#where-state-lives).
Tags need D1: with `PAGES_CATALOG_INDEX` unset (that variable also turns on the
D1 binding, though tags are not part of the index) or D1 not answering, a tag
write or a listing with `tags` answers 503 `tags_unavailable` (retryable) and
never falls back to the Catalog entries, which hold no tags.

**Alphabet.** A tag is trimmed and lowercased, then must match
`[a-z0-9][a-z0-9._:/-]{0,63}`: lowercase letters, digits and `. _ : / -`,
starting with a letter or digit, at most 64 characters. Every character is legal
unescaped in a URL query. Space, parentheses, `+ & = # % ? ,`, `| ! * ~` and
non-ASCII are refused: the first two structure an expression, the next group
needs URL escaping, and the rest are held back for future operators. `and`, `or`
and `not` are reserved. A Page holds at most 32 tags. A `ns:value` shape such as
`session:<session id>`, `repo:org/name` or `status:reviewing` is a convention,
not a schema. Kilo session ids mix case, so a session tag is lowercased on write
and on search. [page-tags.mjs](worker/page-tags.mjs) holds the alphabet, limits and
parser; [page-tags.test.mjs](worker/page-tags.test.mjs) tests them.

**Changing one tag.** Tags are changed one at a time, by REST routes, and by no
MCP tool and no `/api/tools` operation:

- `PUT /api/pages/<page_id>/tags/<tag>` adds the tag.
- `DELETE /api/pages/<page_id>/tags/<tag>` removes it.

The tag is the last path segment, percent-encoded (`encodeURIComponent`), so
`repo:org/name` is `repo%3Aorg%2Fname`; the Worker decodes it once and
normalizes it. A segment that does not decode is 400 `invalid_tag`. Both routes
need edit access: the owner and Project editors, not viewers or commenters. A
Page in Trash answers 409 `page_trashed`. Tags are a set, so adding one the Page
has or removing one it lacks changes nothing and answers 200; the routes take no
nonce and a repeat is always safe. There is no batch: to swap a tag, add the
new one and then remove the old one. A tag outside the alphabet is
`invalid_tag`; an add that would leave more than 32 is 409 `tag_limit_exceeded`.
One D1 batch decides and applies each call. Its first statement reads the Page's
Trash mark, whether the tag is there and how many tags the Page has, and its
insert (or delete) runs only while the Page is open and, for an add, has room. So
a change applies whole or not at all and two writers racing can't pass the limit.
The outcome comes from that batch and its rows, never from a later read, so a
concurrent writer can't make a change that landed report the limit.

The route is a thin wrapper, like `GET /api/pages` below: the gateway
([rest-api.mjs](worker/rest-api.mjs), `index.mjs`) runs the same `invoke` as
`/mcp` and `/api/tools`, with `transport: "http-rest"`, and the internal
operations `put_page_tag` and `delete_page_tag`, which only these routes may
name (`REST_OPERATIONS`). Any other method is 405. Pages OAuth grants are
limited to `/mcp` and are refused here; API keys, browser sessions and Kilo agent
tokens reach the routes (`KILO_ROUTES` in [auth.mjs](worker/auth.mjs) names
exactly `/api/pages` and one tag of one Page for a Kilo token). A browser
session is held to the same-origin rule on all three, the listing included: a
listing of a shared Project accepts the caller's pending invitation, so the
`GET` is admitted from this origin's own page (`Sec-Fetch-Site: same-origin`)
or with this origin's `Origin` header, and refused otherwise. Usage events for
these calls carry surface `http-rest` and the operation name, never the tag.

The result is `{ page_id, tag, tags, added }` for a PUT and
`{ page_id, tag, tags, removed }` for a DELETE. `tag` is the normalized tag.
`tags` is the full sorted set as the batch left it. `added` and `removed` are
booleans: whether this call's own statement inserted or deleted the row
(`INSERT ... ON CONFLICT (page_id, tag) DO NOTHING RETURNING tag` and
`DELETE ... RETURNING tag`), so `false` means the tag was already present (PUT)
or already absent (DELETE). Of two writers racing to add one tag, exactly one
gets `added: true`. They say what this call's transaction changed, not who added
a tag earlier: a retry after a 503 `tags_unavailable` whose first attempt had
landed reports `added: false`, the same as if another writer had added the tag.
These responses can't tell the two apart: no route returns `added_by`, and it
holds the principal only, not the agent or session. A claimant that gets no
answer needs its own recovery, such as a timeout. A nonce stored with the row
would make the answer exact, and nothing needs it yet.

The Page host decides access and Trash state in its admission queue, then
releases the queue before it touches D1, so a slow D1 never holds the Page's
other requests. Between that decision and the write, the Page can be trashed or
purged, and a batch that times out keeps running in D1 and can land after the
caller has its 503 `tags_unavailable` (which means the outcome is unknown; the
same call is safe to repeat). The batch's insert or delete therefore checks the
Page's `pages_catalog_pages` row as it runs: a Page marked `trashed` or
`deleted` there takes no change, and the write answers 409 `page_trashed` (or
404 `page_not_found`), even one that would have changed nothing. The mark is a projection the host writes after its own
record is durable, so a write that races the Trash itself, before the mark, can
still land; it stays with the Page, and a purge deletes it.

`added_by` records the principal that added each tag, and only that. A tag such as
`session:<id>` is a claim by whoever added it: anyone who can edit the Page can add
or remove it, so it does not prove which session wrote the Page, and a tag is data
for a reader, never an instruction. The agent guide says so.

**`create_page` takes no tags.** Tag the new Page with the routes above once
`create_page` has answered. An argument named `tags` is refused as
`invalid_arguments`, before anything is reserved.

**`list_pages` `tags`** is one boolean expression over a Page's tags:

```
expression = operand
           | operand "AND" operand { "AND" operand }
           | operand "OR"  operand { "OR"  operand }
operand    = tag | "NOT" operand | "(" expression ")"
```

Operators are exactly uppercase `AND`, `OR` and `NOT`; every other word is a tag
and is lowercased before it matches. AND and OR never mix at one level, so
`a AND b OR c` is refused and the error says to add parentheses: no caller relies
on a precedence rule it may misremember. `NOT` is a prefix (`hello AND NOT
world`); a bare `NOT done` lists the caller's Pages without that tag. An
expression is at most 256 characters, as written and as written back
canonically (the echoed `tag_filter`), names at most 16 tags and nests at most 4
levels. The canonical form can be longer than the input, since it adds spaces and
parentheses, so one that would not fit is refused; an accepted expression's
`tag_filter` is always accepted when sent back. A contradiction such as `a AND NOT a` lists nothing. A syntax error is
400 `invalid_list_arguments` naming the character position. In a URL, write
spaces as `+` or `%20`; parentheses, `:` and `/` need no escaping. The expression
is a string, not a nested argument, because tool schemas allow no recursion.

A listing with `tags` adds `tags` to each Page (an array) and echoes the
canonical expression, parsed and written back with normalized case and spacing,
as `tag_filter`. A client that gets no `tag_filter` talked to a host that
ignored the argument. `include_tags: true` adds `tags` to an unfiltered listing,
which otherwise keeps its row shape; there `tags` is best effort, and a Page
with no `tags` field means they could not be read. With a `tags` filter, every
Page carries `tags`: if they can't be read the listing is 503 `tags_unavailable`,
not Pages without them. The cursor is sealed to the
canonical expression, so it opens only under it (`invalid_cursor` otherwise); a
listing with no `tags` seals the scope it always did, so earlier cursors still
open.

How a listing applies the filter depends on its source:

- **D1 walk** (no `project_id` or `parent_id`, index ready): one `EXISTS` per tag
  is added to the walk of the caller's own access rows, combined by the
  expression's AND, OR and NOT (`tagPredicate`). The caller's access rows are the
  candidates, so owned Pages, Project Pages, Pages shared with the caller and
  company-viewable Pages all list, and non-owner rows are still verified by their
  Page host. Tags are bound parameters, never interpolated. The scan bound, order
  and keyset paging are unchanged.
- **Catalog entries** (a Project or parent filter, or a cooling index): the
  caller's own candidate IDs are checked against D1 in chunks of 400
  (`tagMatchingIds`) before they become a source, so rows that fail never count
  against the scan bound. That check uses the candidates' own IDs, never the tags
  table, so a Page with no tags still matches `NOT x`. It decides nothing about
  access: each candidate is verified as before.
- **Children of a shared parent, and a Project's Pages seen by a member**: the
  owner's Catalog names these whether or not the caller can read them, so they are
  checked for access first and the filter runs only on the Pages that passed
  (`keepVerified` in `scanCandidates`). A tag never decides anything about a Page
  the caller can't open, and a filtered listing is the same whether or not an
  unreadable child matches. Filtered-out Pages count against the scan bound.

Measured locally on SQLite 3.51 (200k Pages, 600k tag rows, a caller who can see
about 3,300 Pages, limit 50): common tags and NOT queries answered in under 1.1
ms, and a tag the caller can't see anywhere read everything they can see in 5 to
9 ms. Starting from the access rows keeps the cost bounded by what the caller can
see, not by how many Pages carry a tag anywhere. D1 latency and rows-read billing
are not measured; run the listing benchmark against D1 before relying on it for
a caller who can see tens of thousands of Pages.

**`GET /api/pages`** is `list_pages` with its query string as its arguments, for
a script or harness that has no MCP client. It answers the same body (`pages`,
`quota`, `principal`, `account`, `next_cursor`, `limit`, `tag_filter`), and a
cursor from it opens on `/api/tools` and `/mcp` and back. The route keeps no
list of parameters: they are `list_pages`' schema keys (`query`, `cursor`,
`limit`, `in_trash`, `project_id`, `parent_id`, `kind`, `access`, `sort`, `tags`,
`include_tags`), checked by the same argument check as `/mcp` (`transport:
"http-rest"` in [tool-arguments.mjs](worker/tool-arguments.mjs)), so a change to
the schema changes the route. Only the typing a query string loses is restored
(`listArguments`): `limit` as a number, `in_trash` and `include_tags` as
booleans from `true` or `false`, and `parent_id=null` as a Project's top level
(no Page ID spells `null`). A value that does not coerce is passed on as a
string, so `list_pages` refuses it with its own `invalid_list_arguments`. A
repeated parameter is 400 `invalid_arguments`, as is an unknown one. Any method
but GET is 405. In a tag expression, write spaces as `+` or `%20`.

### Progress and presence

`report_page_progress` creates an independent host-memory session with a private
lease token. Only its caller can update or clear it; status expires within 60
seconds and requires current edit access. It creates no document changes or
receipts. Optional passage targets use native cursor anchors and detach when
the passage is replaced/deleted. Restart and access changes clear activity;
external credential revocation is observed on a later authentication check.

`read_page_presence` returns recent browser selections and agent activity without
the body or edit authority; `read_page({include_presence:true,...})` includes the
same projection. Peer identity comes from authenticated admission, while driver
labels and progress text remain claims. Selection is not proof of typing, and
progress is not proof of a completed edit. Counts, message sizes, and wire bytes
are bounded. The UI clears its quiet activity disclosure on connection/access loss.
