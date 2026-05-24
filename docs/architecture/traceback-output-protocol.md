# Structured Kernel Traceback Output Protocol

**Status:** Draft, 2026-05-24.

## Context

Classic Jupyter tracebacks are primarily strings: an exception name, value, and
ANSI traceback lines. That is portable, but it forces every richer client to
reparse text to find frames, source locations, syntax offsets, library frames,
or the notebook cell that defined a function.

nteract's launcher now emits a structured traceback MIME payload:

```text
application/vnd.nteract.traceback+json
```

This ADR records the payload contract and the safety rules separately from the
current implementation so it can be discussed with IPython and ipykernel.

Neighbors:

- `python/nteract-kernel-launcher/nteract_kernel_launcher/_traceback.py` -
  current producer.
- `docs/architecture/execution-pipeline.md` - output ordering and runtime
  manifest durability.
- `docs/architecture/frontend-sync-bridge.md` - output rendering boundaries.

## Decision 1: The payload is structured data plus plain text fallback

The rich payload has these top-level fields:

```json
{
  "ename": "ValueError",
  "evalue": "bad input",
  "language": "python",
  "frames": [],
  "syntax": null,
  "execution": {
    "execution_id": "exec-123",
    "execution_count": 7
  },
  "text": "Traceback (most recent call last):\n...",
  "raw_text": "Traceback (most recent call last):\n..."
}
```

`text` is the client-friendly plain rendering of the structured payload.
`raw_text` is Python's original traceback text. Renderers should prefer the
structured fields, fall back to `text`, and use `raw_text` for diagnostics or
copy/export of the original interpreter output.

The payload is additive-only in v1: new fields must be optional, and existing
field meanings must remain stable. It must not remove the ability to show a
traceback if the rich renderer is absent or broken.

## Decision 2: Frames are source-aware records

Each frame is a JSON object:

```json
{
  "filename": "/tmp/ipykernel_123/abc.py",
  "lineno": 12,
  "name": "transform",
  "library": false,
  "lines": [
    { "lineno": 10, "source": "def transform(x):" },
    { "lineno": 11, "source": "    y = x + 1" },
    { "lineno": 12, "source": "    raise ValueError(y)", "highlight": true }
  ],
  "execution_id": "exec-def",
  "execution_count": 5,
  "source_hash": "sha256:<source-hash>",
  "source_ref": {
    "kind": "notebook_execution",
    "execution_id": "exec-def",
    "execution_count": 5,
    "source_hash": "sha256:<source-hash>",
    "compiled_filename": "/tmp/ipykernel_123/abc.py"
  }
}
```

`library` is a hint for UI grouping and dimming, not an authorization boundary.
`lines` is a bounded source window around the failing line. `source_ref`
connects compiled filenames back to notebook cell execution provenance when
the kernel can supply it. `source_ref.kind` is an open-ended string; the current
well-known value is `"notebook_execution"`, not a closed enum.

## Decision 3: Syntax errors use a dedicated `syntax` record

Parser errors often have no useful user-code stack frame. The payload should
carry syntax information directly from the exception object:

```json
{
  "filename": "/tmp/ipykernel_123/syntax.py",
  "lineno": 1,
  "offset": 8,
  "end_lineno": 1,
  "end_offset": 9,
  "text": "def bad(",
  "msg": "invalid syntax",
  "source_ref": {
    "kind": "notebook_execution",
    "execution_id": "exec-123"
  }
}
```

Clients can then render a caret range without reverse-engineering CPython's
formatted traceback lines.

## Decision 4: Rich traceback emission must be fail-open

Traceback rendering is an error path. The protocol implementation must never
make a user lose the underlying traceback.

The current launcher follows these rules:

- install a wrapper around IPython's traceback hook only once;
- build and publish the rich payload inside a broad safety boundary;
- propagate intentional control flow such as `SystemExit` and
  `KeyboardInterrupt`;
- on any other failure, call the original traceback implementation;
- if even the original traceback path fails, do not raise a secondary exception
  that obscures the user's original error.

The upstreamable invariant is stronger than the current transport choice:
structured tracebacks can be carried as a MIME output, as error-message
metadata, or as a future Jupyter message field, but construction failure must
fall back to the classic traceback.

## Decision 5: Payloads are bounded and redacted by default

The producer should avoid turning exceptional states into unbounded or
sensitive output:

- deep stacks are clipped to head frames, a sentinel, and tail frames;
- leading library frames above the first user frame may be stripped;
- source windows are small;
- environment variable values are redacted by default, except for values from
  keys known to be non-secret and values that are too short or common to be
  useful secrets;
- redaction can be disabled explicitly for debugging.

Redaction is best-effort traceback output hygiene, not a security boundary.
Kernel code already has access to the user's process environment. Other output
channels need their own producer-side policy if they should get the same
scrubbing before entering runtime state or blob storage.

## Decision 6: Vendor MIME is the incubation boundary

The current MIME name is a nteract vendor name on purpose. The upstreamable
part is the payload contract and failure behavior:

1. A structured traceback payload carries frames, syntax information, source
   provenance, and plain-text fallbacks.
2. Payload evolution is additive-only in v1.
3. Rich traceback construction must fail open to classic traceback output.
4. The final transport may be a MIME bundle, `error` message metadata, or a
   future Jupyter message field.

## Consequences

- Frontends can render tracebacks without parsing ANSI strings.
- LLM tools can reason about exception structure and source provenance.
- A future IPython/ipykernel proposal can focus on the payload and fail-open
  invariant before choosing the final Jupyter transport.
- Existing plain traceback behavior remains the fallback.

## Open Questions

1. Whether upstream Jupyter should attach this to `error` messages, emit it as
   a rich MIME bundle, or standardize a new structured traceback field.
2. Which `source_ref.kind` values should be treated as well-known across
   scripts, magics, generated code, and non-Python kernels.
3. Which redaction controls belong in IPython, ipykernel, or frontend policy,
   and whether the same environment-value scrubbing should apply to stream
   outputs before they enter runtime state.
