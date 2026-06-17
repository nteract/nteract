# MCP Resource Addressing

**Status:** Draft, 2026-05-25.

## Context

The MCP server now exposes read-only notebook resources alongside the existing
tool surface:

- `nteract://notebooks`
- `nteract://notebooks/{notebook_id}/cells`
- `nteract://notebooks/{notebook_id}/cells/{cell_id}`
- `nteract://notebooks/{notebook_id}/comments`

This gives MCP clients a normal resource-read path for active notebook and cell
snapshots, but it also creates a naming question for outputs and subscriptions.
The same project also has room locators such as `local-daemon:<uuid>`,
`https://notebooks.example/n/<id>`, and
`wss://notebooks.example/n/<id>/sync`. Those names are addresses for room
hosts, while MCP resource URIs are local read APIs exposed by a particular MCP
server process.

The tempting shortcut is to collapse these namespaces into one notebook URI
scheme. That would blur three separate concerns:

- where a room host can be reached;
- whether a principal is authorized to access that room;
- how an MCP client asks its already-connected MCP server for a resource
  snapshot.

## Decision 1: MCP resources use a local `nteract://` namespace

`nteract://` is the MCP resource namespace for data exposed by the nteract MCP
server. It is not a room locator and does not grant access.

The server only answers notebook-scoped resources for rooms that are visible to
that MCP server:

- active daemon rooms for `nteract://notebooks`;
- connected or parked MCP sessions for cell and comment resources.

That keeps resource reads from implicitly creating daemon peers or resurrecting
evicted ephemeral rooms. If a client wants to read a notebook that is not
already connected or parked, it must first use the normal session tools such as
`connect_notebook`.

Resource path segments are percent-encoded independently. Notebook ids, cell
ids, execution ids, and output ids must never be interpolated raw into paths.

## Decision 2: Static listing stays bounded

`resources/list` should include stable top-level resources and currently
available collection resources, not every addressable leaf.

The static list may include:

- `ui://nteract/output.html`
- `nteract://notebooks`
- `nteract://notebooks/{notebook_id}/cells` for connected or parked notebooks
- `nteract://notebooks/{notebook_id}/comments` for connected or parked notebooks

Individual cells and outputs are discoverable through resource templates and
collection payloads, then read directly. This avoids unbounded resource lists
for notebooks with hundreds or thousands of cells.

Comment resources follow the same bounded-list rule. The notebook-level comments
resource is small enough to list for connected or parked notebooks. Cell-scoped
and thread-scoped comment resources are discoverable through templates and the
projected comments payload instead of expanding every thread into
`resources/list`.

## Decision 3: Output resources are execution-aware

Runtime output state is durable in `RuntimeStateDoc`, keyed by execution id and
output id. Cell snapshots point at the current execution id for that cell.

The canonical durable output resource should therefore be:

```text
nteract://notebooks/{notebook_id}/executions/{execution_id}/outputs/{output_id}
```

For client ergonomics, a current-cell convenience path can also exist:

```text
nteract://notebooks/{notebook_id}/cells/{cell_id}/outputs/{output_id}
```

The current-cell form resolves through the cell's current execution pointer. It
is useful when a client is navigating from a cell snapshot, but it is not a
stable historical output address across cell re-execution. Responses should
include the resolved `execution_id` so clients can pin the canonical path when
they need stability.

Output collection resources should follow the same rule:

```text
nteract://notebooks/{notebook_id}/executions/{execution_id}/outputs
nteract://notebooks/{notebook_id}/cells/{cell_id}/outputs
```

Large output payloads should remain manifest/blob based. A resource read may
summarize, resolve small inline payloads, or return blob URLs, but it should not
invent a second durable output record outside `RuntimeStateDoc`.

## Decision 4: Room locators and MCP resources do not overlap

Room locators remain addresses for document hosts:

| Name | Purpose |
|------|---------|
| `local-daemon:<uuid>` | local daemon room locator |
| `https://notebooks.example/n/<id>` | hosted room/app locator |
| `wss://notebooks.example/n/<id>/sync` | hosted sync endpoint |
| `nteract://notebooks/{id}/...` | MCP resource read namespace |

An MCP resource URI must not be treated as a credential, ACL row, room host, or
runtime attachment target. The authorization boundary is still the MCP server's
connection to the daemon or hosted room, and hosted deployments still enforce
room ACLs at the room host.

If a future MCP server reads hosted rooms directly, it should keep this shape:
the hosted URL is the room locator used to establish an authorized session, and
the `nteract://` URI is the local resource name exposed after that session
exists.

## Decision 5: Keep `get_*` tools for now

Resources are the better fit for read-only snapshots, discovery, and direct URI
addressing. They should become the preferred path for clients that already know
what they want to read.

Do not drop `get_all_cells`, `get_cell`, or `get_results` yet:

- many MCP clients expose tools better than resource templates;
- `get_cell(full_output=true)` and `get_results` still have richer output
  resolution behavior than the first resource slice;
- tools can return task-oriented text plus structured content, while resources
  are intentionally document-like snapshots;
- removing tools would break clients before resource support and subscriptions
  are proven.

The migration path is to add parity first, then de-emphasize read-only `get_*`
tools in descriptions or hide them behind compatibility only after clients use
resources reliably. Mutating and control-plane tools remain tools.

`list_comments` follows the same compatibility rule: the canonical read model is
`nteract://notebooks/{notebook_id}/comments`, but a tool remains useful while
MCP clients differ in how they expose resources. Mutating comment actions remain
tools because they create or request state transitions.

## Decision 6: Subscriptions are feasible but separate

`rmcp` supports `resources/subscribe`, `resources/unsubscribe`, and
`notifications/resources/updated`. Implementing subscriptions is feasible, but
it should be a separate PR because it needs server and proxy state:

1. advertise `resources.subscribe`;
2. validate subscribed URIs with the same parser as `read_resource`;
3. track subscribed URIs per MCP peer;
4. watch the relevant notebook/runtime documents;
5. coalesce updates and send `notifications/resources/updated` with only the
   resource URI;
6. rely on the client to call `resources/read` after notification;
7. remove subscriptions when a session disconnects, parks, evicts, or the MCP
   child restarts.

Subscriptions should start with coarse resources:

- `nteract://notebooks`
- `nteract://notebooks/{notebook_id}/cells`
- `nteract://notebooks/{notebook_id}/cells/{cell_id}`
- `nteract://notebooks/{notebook_id}/comments`

Output subscriptions should wait until output resource paths exist. Cell- or
thread-scoped comment subscriptions should be a separate follow-up from the
initial resource implementation; coarse comments subscription can notify the
notebook-level comments resource.

## Non-Goals

- Replacing room locators with MCP resource URIs.
- Encoding authorization, provider identity, or runtime attachment in resource
  paths.
- Streaming output bytes through resource notifications.
- Removing read-only `get_*` tools in the same change that introduces resource
  addressing.
- Replacing mutating comment tools with resource writes.

## Open Questions

1. Whether output resources should expose resolved structured content, raw
   runtime manifests, or both through separate suffixes.
2. Whether clients need a resource for historical executions independent of
   cells.
3. Whether subscribed cell resources should notify for output-only changes, or
   whether that should wait for output collection resources.
