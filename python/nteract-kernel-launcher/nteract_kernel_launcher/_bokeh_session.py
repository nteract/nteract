"""Kernel-owned Bokeh document sessions.

Producer adapters such as Panel create a document and roots; this module owns
the process-local lifetime of the live callback graph and turns Bokeh document
events into normalized deltas for the runtime agent's session document (see
``docs/adr/bokeh-session-documents.md``):

- ``models_added``: ``{id: {type, ref_props, props}}`` for models that joined
  the document since the last delta.
- ``props_changed``: ``{id: {attr: value}}`` with current Python values.
- ``models_removed``: ids that left the document.
- ``data_events``: versioned ``ColumnDataSource.data`` changes and folds. A
  stream or patch re-emitted from a foreign patch carries ``echo_of``, the
  index of that edit in the patch's events.
- ``messages``: Python-originated ``MessageSent`` one-off events.

Property values are Bokeh-encoded JSON with arrays inlined, so each value is
self-contained. Column payloads keep Bokeh's out-of-band buffers, referenced
by id from ``{"type": "bytes", "data": {"id": ...}}``.
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import threading
import time
import uuid
import weakref
from collections.abc import Callable, Iterable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass, field, replace
from typing import Any

log = logging.getLogger("nteract_kernel_launcher")

BOKEH_SESSION_MIME = "application/vnd.nteract.bokeh-session.v1+json"
BOKEH_SESSION_SCHEMA_VERSION = 1

# A scheduled loop flush that has waited this long means the loop is blocked
# (a running cell), so changes are published from the calling thread instead.
INLINE_FLUSH_DELAY = 0.05

# Phase 0: folding when event bytes reach twice the last fold keeps the kernel
# hop at most ~1.5 events per tick for any table size.
FOLD_BYTE_RATIO = 2
FOLD_QUIET_SECONDS = 2.0

_ref_props_cache: dict[type, list[str]] = {}

# Returns the kernel's IOLoop; set by the kernel-hook install.
_kernel_io_loop: Callable[[], Any] | None = None

_sessions_lock = threading.Lock()
_sessions_by_document: weakref.WeakKeyDictionary[Any, weakref.WeakSet[BokehDocumentSession]] = (
    weakref.WeakKeyDictionary()
)
_column_data_wrapped = False


@dataclass(frozen=True)
class BokehBuffer:
    """A Bokeh serialization buffer before it enters nteract blob storage."""

    id: str
    data: bytes

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()

    def descriptor(self, buffer_index: int) -> dict[str, Any]:
        return {
            "id": self.id,
            "hash": self.sha256,
            "size": len(self.data),
            "buffer_index": buffer_index,
        }


@dataclass(frozen=True)
class BokehSerialization:
    """JSON-clean Bokeh content and its out-of-band binary buffers."""

    content: dict[str, Any]
    buffers: tuple[BokehBuffer, ...] = ()

    def buffer_descriptors(self) -> list[dict[str, Any]]:
        return [buffer.descriptor(index) for index, buffer in enumerate(self.buffers)]


@dataclass(frozen=True)
class BokehCheckpoint:
    """The display-time state: Bokeh DocJson plus the normalized session state."""

    document: BokehSerialization
    session_doc: BokehSerialization


@dataclass(frozen=True)
class BokehDelta:
    """One flush of kernel-side changes for the runtime agent."""

    session_id: str
    transaction_id: str
    models_added: dict[str, dict[str, Any]] = field(default_factory=dict)
    props_changed: dict[str, dict[str, Any]] = field(default_factory=dict)
    models_removed: list[str] = field(default_factory=list)
    data_events: list[dict[str, Any]] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] | None = None
    buffers: tuple[BokehBuffer, ...] = ()

    def is_empty(self) -> bool:
        return not (
            self.models_added
            or self.props_changed
            or self.models_removed
            or self.data_events
            or self.messages
            or self.meta
        )

    def content(self) -> dict[str, Any]:
        content: dict[str, Any] = {
            "session_id": self.session_id,
            "transaction_id": self.transaction_id,
            "models_added": self.models_added,
            "props_changed": self.props_changed,
            "models_removed": self.models_removed,
            "data_events": self.data_events,
            "messages": self.messages,
        }
        if self.meta is not None:
            content["meta"] = self.meta
        return content


@dataclass(frozen=True)
class BokehPatchResult:
    transaction_id: str
    delta: BokehDelta | None


@dataclass(frozen=True)
class BokehFoldResult:
    """Sources folded now; ``deferred`` means the fold follows once the document is free."""

    folded: list[str]
    deferred: bool = False


class BokehSessionError(RuntimeError):
    pass


class BokehSessionClosedError(BokehSessionError):
    pass


class BokehPatchApplyError(BokehSessionError):
    """Patch application failed after the document may have partially changed.

    Bokeh document mutation is not transactional, so the delta published for
    the transaction carries the current value of every touched property.
    """

    def __init__(self, message: str, *, transaction_id: str) -> None:
        self.transaction_id = transaction_id
        super().__init__(message)


@dataclass
class _SourceState:
    version: int = 0
    column_sizes: dict[str, int] = field(default_factory=dict)
    bytes_since_fold: int = 0
    last_event_at: float = 0.0

    @property
    def fold_size(self) -> int:
        return sum(self.column_sizes.values())


class _Encoded:
    """Data-event payloads and the buffers they reference."""

    def __init__(self) -> None:
        self.buffers: list[BokehBuffer] = []

    def encode(self, value: Any, references: Iterable[Any] = ()) -> tuple[Any, int]:
        """Bokeh-encode with out-of-band buffers; returns JSON and its byte size."""
        from bokeh.core.json_encoder import serialize_json
        from bokeh.core.serialization import Serializer

        serializer = Serializer(references=set(references), deferred=True)
        text = serialize_json(serializer.encode(value))
        buffers = [BokehBuffer(str(buffer.id), bytes(buffer.data)) for buffer in serializer.buffers]
        self.buffers.extend(buffers)
        return json.loads(text), len(text) + sum(len(buffer.data) for buffer in buffers)


@dataclass(frozen=True)
class _FrozenDataEvent:
    """A stream or patch encoded when Bokeh triggered it.

    Callers may reuse or mutate the payload in place after ``stream`` or
    ``patch`` returns, so encoding at flush time could replay later values.
    """

    model: Any
    setter: Any
    kind: str
    columns: frozenset[str]
    payload: Any
    size: int
    buffers: tuple[BokehBuffer, ...]
    rollover: int | None = None
    echo_of: int | None = None

    @classmethod
    def freeze(cls, event: Any) -> _FrozenDataEvent:
        from bokeh.document.events import ColumnsStreamedEvent

        encoded = _Encoded()
        if isinstance(event, ColumnsStreamedEvent):
            payload, size = encoded.encode(event.data)
            return cls(
                event.model,
                event.setter,
                "ColumnsStreamed",
                frozenset(event.data),
                payload,
                size,
                tuple(encoded.buffers),
                rollover=event.rollover,
            )
        payload, size = encoded.encode(event.patches)
        return cls(
            event.model,
            event.setter,
            "ColumnsPatched",
            frozenset(event.patches),
            payload,
            size,
            tuple(encoded.buffers),
        )


@dataclass(frozen=True)
class _ReplacedColumns:
    """A stream or patch whose payload could not be encoded; sent as a replacement."""

    model: Any
    setter: Any
    cols: list[str]


def _data_edit_indices(patch: Mapping[str, Any]) -> list[int]:
    """Positions of the stream and patch events in a foreign patch."""
    events = patch.get("events")
    if not isinstance(events, list):
        return []
    return [
        index
        for index, event in enumerate(events)
        if isinstance(event, dict) and event.get("kind") in ("ColumnsStreamed", "ColumnsPatched")
    ]


def _serialize_bokeh_value(value: Any) -> BokehSerialization:
    """Normalize Bokeh's ``Serialized`` value into JSON plus raw buffers."""
    from bokeh.core.json_encoder import serialize_json

    content = getattr(value, "content", value)
    raw_buffers = getattr(value, "buffers", ())
    encoded = json.loads(serialize_json(content))
    if not isinstance(encoded, dict):
        raise TypeError("Bokeh serialization content must be a JSON object")

    buffers = tuple(
        BokehBuffer(id=str(buffer.id), data=bytes(buffer.data)) for buffer in raw_buffers
    )
    return BokehSerialization(content=encoded, buffers=buffers)


def _current_io_loop() -> Any:
    """The kernel's IOLoop, which runs Bokeh session callbacks."""
    import asyncio

    from tornado.ioloop import IOLoop

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        loop = IOLoop.current(instance=False)
        if loop is None and _kernel_io_loop is not None:
            # Panel can build a document on a worker thread; its session
            # callbacks, such as a threaded hold's release, still need a loop.
            loop = _kernel_io_loop()
        return loop
    return IOLoop.current()


def set_kernel_io_loop(get_loop: Callable[[], Any] | None) -> None:
    """Set how sessions created off the kernel's thread find its IOLoop."""
    global _kernel_io_loop
    _kernel_io_loop = get_loop


def _track_document(document: Any, session: BokehDocumentSession, *, track: bool) -> None:
    with _sessions_lock:
        sessions = _sessions_by_document.get(document)
        if track:
            if sessions is None:
                sessions = _sessions_by_document[document] = weakref.WeakSet()
            sessions.add(session)
        elif sessions is not None:
            sessions.discard(session)


def _wrap_column_data_mutations() -> None:
    """Mark each stream and patch as in flight from its mutation to its trigger.

    Bokeh changes ``source.data`` before it triggers the event, so a fold or
    replacement encoded on another thread in between would carry rows that
    the event then adds a second time.
    """
    global _column_data_wrapped
    from bokeh.core.property.wrappers import PropertyValueColumnData

    with _sessions_lock:
        if _column_data_wrapped:
            return
        _column_data_wrapped = True

        def wrap(original: Callable[..., Any]) -> Callable[..., Any]:
            @functools.wraps(original)
            def mutate(self: Any, doc: Any, *args: Any, **kwargs: Any) -> Any:
                with _sessions_lock:
                    sessions = list(_sessions_by_document.get(doc, ())) if doc is not None else []
                for session in sessions:
                    session._begin_data_mutation()
                try:
                    return original(self, doc, *args, **kwargs)
                finally:
                    for session in sessions:
                        session._end_data_mutation()

            return mutate

        PropertyValueColumnData._stream = wrap(PropertyValueColumnData._stream)
        PropertyValueColumnData._patch = wrap(PropertyValueColumnData._patch)


def ref_props(model_class: type) -> list[str]:
    """Properties whose descriptor can hold model references; peers never write them."""
    cached = _ref_props_cache.get(model_class)
    if cached is None:
        cached = sorted(
            name for name in model_class.properties() if model_class.lookup(name).property.has_ref
        )
        _ref_props_cache[model_class] = cached
    return cached


def _same_json(a: Any, b: Any) -> bool:
    """JSON equality where ``1 == 1.0`` but ``true != 1``."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same_json(a[key], b[key]) for key in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same_json(x, y) for x, y in zip(a, b, strict=True))
    return type(a) is type(b) and a == b


def _requested_props(patch: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """The ``(model, attr) -> value`` pairs a foreign patch asks for."""
    requested: dict[str, dict[str, Any]] = {}
    events = patch.get("events")
    if not isinstance(events, list):
        return requested
    for event in events:
        if not isinstance(event, dict) or event.get("kind") != "ModelChanged":
            continue
        model = event.get("model")
        attr = event.get("attr")
        if isinstance(model, dict) and isinstance(model.get("id"), str) and isinstance(attr, str):
            requested.setdefault(model["id"], {})[attr] = event.get("new")
    return requested


def _mark_echoes(events: Sequence[Any], setter: str, indices: Sequence[int]) -> list[Any]:
    """Mark a foreign patch's own data edits with ``echo_of`` and drop its other echoes.

    Bokeh applies the patch's events in order under its setter; callbacks
    use their own (normally no) setter. The patch's property writes are
    already in the session document and its messages came from the peer, so
    only its data edits are re-emitted, with a version.
    """
    from bokeh.document.events import MessageSentEvent, ModelChangedEvent

    positions = iter(indices)
    marked = []
    for event in events:
        if getattr(event, "setter", None) != setter:
            marked.append(event)
        elif isinstance(event, _FrozenDataEvent):
            marked.append(replace(event, echo_of=next(positions, None)))
        elif isinstance(event, MessageSentEvent) or (
            isinstance(event, ModelChangedEvent) and not _is_data_event(event)
        ):
            continue
        else:
            marked.append(event)
    return marked


class _RequestedMatcher:
    """Whether a property holds the value a foreign patch asked for.

    Comparing JSON is not enough: peers encode arrays with other gzip
    settings, so equal values have different base64. Decode the request and
    compare as the property descriptor does.
    """

    def __init__(self, models: Iterable[Any], buffers: Sequence[BokehBuffer]) -> None:
        self._models = list(models)
        self._buffers = buffers

    def __call__(self, model: Any, attr: str, actual: Any, requested: Any) -> bool:
        if _same_json(actual, requested):
            return True
        from bokeh.core.serialization import Buffer, Deserializer, Serialized
        from bokeh.core.types import ID

        prop = model.lookup(attr).property
        try:
            value = Deserializer(self._models).deserialize(
                Serialized(
                    content=requested,
                    buffers=[Buffer(ID(buffer.id), buffer.data) for buffer in self._buffers],
                )
            )
            value = prop.prepare_value(model, attr, value)
            current = getattr(model, attr)
            # ``True == 1`` in Python, not in JSON.
            if isinstance(value, bool) != isinstance(current, bool):
                return False
            return bool(prop.matches(value, current))
        except Exception:  # noqa: BLE001
            return False


def _is_column_source(model: Any) -> bool:
    from bokeh.models import ColumnDataSource

    return isinstance(model, ColumnDataSource)


def _is_data_event(event: Any) -> bool:
    """Streams, patches and replacements of ``ColumnDataSource.data``."""
    from bokeh.document.events import (
        ColumnDataChangedEvent,
        ColumnsPatchedEvent,
        ColumnsStreamedEvent,
        ModelChangedEvent,
    )

    if isinstance(event, ColumnsStreamedEvent | ColumnsPatchedEvent | ColumnDataChangedEvent):
        return True
    return (
        isinstance(event, ModelChangedEvent)
        and event.attr == "data"
        and _is_column_source(event.model)
    )


class BokehDocumentSession:
    """A live Bokeh document that publishes normalized deltas."""

    def __init__(
        self,
        document: Any,
        roots: Sequence[Any],
        *,
        producer_name: str,
        producer_version: str,
        session_id: str | None = None,
        cleanup: Callable[[], None] | None = None,
        event_sink: Callable[[BokehDelta], None] | None = None,
        announced: bool = True,
    ) -> None:
        import bokeh

        self.session_id = session_id or str(uuid.uuid4())
        self.document = document
        self.roots = tuple(roots)
        self.producer_name = producer_name
        self.producer_version = producer_version
        self.bokeh_version = bokeh.__version__
        self._cleanup = cleanup
        self._event_sink = event_sink
        # Guards session state; never held while user callbacks run.
        self._lock = threading.RLock()
        # Serializes foreign transactions, which run callbacks without ``_lock``.
        self._transaction_lock = threading.RLock()
        # Threads between a stream or patch's mutation of ``source.data`` and its trigger.
        self._data_mutations: set[int] = set()
        self._mutations_done = threading.Condition(self._lock)
        self._deferred_folds: set[str] = set()
        self._deferred_fold_all = False
        self._deferred_fold_transaction: str | None = None
        self._announced = announced
        self._active_setter: str | None = None
        self._transaction_events: list[Any] = []
        self._queued_deltas: list[BokehDelta] = []
        self._pending_events: list[Any] = []
        self._flush_scheduled = False
        self._flush_scheduled_at = 0.0
        self._quiet_fold_scheduled = False
        self._held_retry_scheduled = False
        self._closed = False
        self._loop = _current_io_loop()
        self._session_callbacks: dict[Any, Callable[[], None]] = {}
        self._known_models: set[str] = set(self._current_models())
        self._sources: dict[str, _SourceState] = {}
        self._triggered_data_events: weakref.WeakSet[Any] = weakref.WeakSet()
        self.document.on_change_dispatch_to(self)
        self._unhook_trigger = self._hook_trigger_on_change()
        _wrap_column_data_mutations()
        _track_document(document, self, track=True)

    @property
    def root_ids(self) -> list[str]:
        return [str(root.id) for root in self.roots]

    @property
    def announced(self) -> bool:
        with self._lock:
            return self._announced

    def set_event_sink(self, sink: Callable[[BokehDelta], None] | None) -> None:
        with self._lock:
            self._event_sink = sink

    def mark_announced(self) -> None:
        """The session's display message is on the wire; deltas may follow it."""
        with self._lock:
            if self._announced or self._closed:
                return
            self._announced = True
            self._flush_pending_unlocked()

    def snapshot(self) -> BokehSerialization:
        return self.checkpoint().document

    def checkpoint(self) -> BokehCheckpoint:
        """DocJson and the normalized session state at the same instant.

        Before the announcement this becomes the baseline that later deltas
        diff against, so changes still pending are covered by the snapshot.
        """
        with self._lock:
            self._ensure_open()
            if self._announced:
                self._flush_pending_unlocked()
            else:
                self._await_data_mutations_unlocked()
                self._pending_events = []
            document = _serialize_bokeh_value(self.document.to_json())
            session_doc = self._session_snapshot_unlocked(document.content)
            return BokehCheckpoint(document=document, session_doc=session_doc)

    def apply_patch(
        self,
        *,
        patch: dict[str, Any],
        buffers: Sequence[BokehBuffer] = (),
        transaction_id: str | None = None,
    ) -> BokehPatchResult:
        """Apply one foreign patch and publish its derived changes and corrections."""
        from bokeh.core.serialization import Buffer, Serialized
        from bokeh.core.types import ID

        transaction_id = transaction_id or str(uuid.uuid4())
        requested = _requested_props(patch)
        with self._transaction_lock:
            with self._lock:
                self._ensure_open()
                # A peer can only patch a session it has seen announced.
                self._announced = True
                self._flush_pending_unlocked()

                setter = f"nteract:{self.session_id}:{transaction_id}"
                self._active_setter = setter
                # Changes a hold kept from flushing were applied first, so they
                # take versions before this transaction's.
                self._transaction_events = self._pending_events
                self._pending_events = []
            serialized_patch: Any = patch
            if buffers:
                serialized_patch = Serialized(
                    content=patch,
                    buffers=[Buffer(ID(buffer.id), buffer.data) for buffer in buffers],
                )

            # Callbacks run without ``_lock``: one that waits for a thread
            # which changes the document would otherwise deadlock. Events from
            # any thread still join the transaction while ``_active_setter`` is set.
            error: BaseException | None = None
            try:
                self.document.apply_json_patch(serialized_patch, setter=setter)
            except BaseException as exc:  # noqa: BLE001
                error = exc

            with self._lock:
                self._await_data_mutations_unlocked()
                events = _mark_echoes(
                    self._end_transaction_unlocked(), setter, _data_edit_indices(patch)
                )
                delta = None
                if not self._closed:
                    delta = self._publish_unlocked(
                        events,
                        transaction_id,
                        requested=requested,
                        requested_buffers=buffers,
                        force_requested=error is not None,
                    )
                    # Folds deferred while the transaction ran.
                    self._flush_pending_unlocked()

        if error is not None:
            if not isinstance(error, Exception):
                raise error
            raise BokehPatchApplyError(str(error), transaction_id=transaction_id) from error
        return BokehPatchResult(transaction_id=transaction_id, delta=delta)

    def correct(self, patch: Mapping[str, Any], transaction_id: str) -> BokehDelta | None:
        """Publish the current value of every property a failed patch touched."""
        with self._transaction_lock, self._lock:
            self._ensure_open()
            self._announced = True
            self._flush_pending_unlocked()
            return self._publish_unlocked(
                [], transaction_id, requested=_requested_props(patch), force_requested=True
            )

    def fold(
        self, source_ids: Iterable[str] | None = None, *, transaction_id: str | None = None
    ) -> BokehFoldResult:
        """Fold sources into full columns on request.

        Without ids, folds every source with data events since its last fold.
        While Bokeh holds events or a foreign patch runs, the fold is deferred
        until the document is free and published under this transaction id.
        """
        transaction_id = transaction_id or str(uuid.uuid4())
        with self._lock:
            self._ensure_open()
            self._announced = True
            self._flush_pending_unlocked()
            if self._pending_events or self._busy_unlocked():
                # A refusal would leave a late joiner waiting for columns
                # that never arrive.
                if source_ids is None:
                    self._deferred_fold_all = True
                else:
                    self._deferred_folds.update(source_ids)
                self._deferred_fold_transaction = transaction_id
                self._schedule_held_retry_unlocked()
                return BokehFoldResult([], deferred=True)
            if source_ids is None:
                ids = [sid for sid, state in self._sources.items() if state.bytes_since_fold]
            else:
                ids = list(source_ids)
            return BokehFoldResult(self._fold_unlocked(ids, transaction_id))

    def pop_deltas(self) -> list[BokehDelta]:
        """Flush, then return deltas that could not be handed to a sink."""
        with self._lock:
            self._flush_pending_unlocked()
            deltas = self._queued_deltas
            self._queued_deltas = []
            return deltas

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._event_sink = None
            self._queued_deltas = []
            self._transaction_events = []
            self._pending_events = []
            self._deferred_folds.clear()
            self._deferred_fold_all = False
            cleanup = self._cleanup

        _track_document(self.document, self, track=False)
        if self._loop is not None:
            self._loop.add_callback(self._cancel_session_callbacks)
        self._unhook_trigger()
        with suppress(KeyError, ValueError):
            self.document.remove_on_change(self)
        if cleanup is not None:
            try:
                cleanup()
            except Exception:  # noqa: BLE001
                log.exception("Bokeh session cleanup failed for %s", self.session_id)

    # ── Bokeh receivers ──────────────────────────────────────────────────

    def _hook_trigger_on_change(self) -> Callable[[], None]:
        """Record column data events where Bokeh triggers them.

        The session receiver runs only after Bokeh releases a hold and after
        the change's own Python callbacks, which may have reused the payload
        or edited the same source. Recording streams, patches and replacements
        at the trigger keeps the payload and the order the kernel applied.
        """
        callbacks = self.document.callbacks
        previous = callbacks.__dict__.get("trigger_on_change")
        trigger = callbacks.trigger_on_change

        def trigger_on_change(event: Any) -> None:
            self._data_event_triggered(event)
            trigger(event)

        callbacks.trigger_on_change = trigger_on_change

        def unhook() -> None:
            # A hook installed later on the same document wraps this one and
            # passes through once this session is closed.
            if callbacks.__dict__.get("trigger_on_change") is trigger_on_change:
                if previous is None:
                    del callbacks.trigger_on_change
                else:
                    callbacks.trigger_on_change = previous

        return unhook

    def _data_event_triggered(self, event: Any) -> None:
        from bokeh.document.events import ColumnsPatchedEvent, ColumnsStreamedEvent

        if not _is_data_event(event):
            return
        with self._lock:
            if isinstance(event, ColumnsStreamedEvent | ColumnsPatchedEvent):
                # The mutation is complete; callbacks run after this, so a
                # thread waiting on the window never waits for user code.
                self._data_mutations.discard(threading.get_ident())
                self._mutations_done.notify_all()
            # ``unhold`` triggers held events a second time.
            if self._closed or event in self._triggered_data_events:
                return
            self._triggered_data_events.add(event)
            # Replacements are published from current values, so only streams
            # and patches need their payload copied.
            if isinstance(event, ColumnsStreamedEvent | ColumnsPatchedEvent):
                try:
                    event = _FrozenDataEvent.freeze(event)
                except Exception:  # noqa: BLE001
                    # Raising here would surface in the caller's stream() or patch().
                    kind = type(event).__name__.removesuffix("Event")
                    log.warning(
                        "Could not encode a %s payload for Bokeh session %s; "
                        "sending its columns instead",
                        kind,
                        self.session_id,
                        exc_info=True,
                    )
                    columns = (
                        event.data if isinstance(event, ColumnsStreamedEvent) else event.patches
                    )
                    event = _ReplacedColumns(event.model, event.setter, list(columns))
            if self._active_setter is not None:
                self._transaction_events.append(event)
                return
            self._pending_events.append(event)
            # Panel can release a hold without dispatching the held events
            # (``_drain_unconnected_events``, ``diff``), so the dispatch is
            # not a reliable flush trigger.
            self._schedule_flush_unlocked()

    def _document_patched(self, event: Any) -> None:
        """Bokeh callback receiver used by ``on_change_dispatch_to``."""
        with self._lock:
            if self._closed:
                return
            # Data events were recorded at their trigger; their dispatch still
            # schedules the flush, since a hold may have deferred it.
            if not _is_data_event(event):
                if self._active_setter is not None:
                    self._transaction_events.append(event)
                    return
                self._pending_events.append(event)
            elif self._active_setter is not None:
                return
            self._schedule_flush_unlocked()

    def _schedule_flush_unlocked(self) -> None:
        if not self._announced:
            return
        if self._loop is None:
            self._flush_pending_unlocked()
            return
        now = time.monotonic()
        if not self._flush_scheduled:
            # One delta per loop iteration while the loop is free.
            self._flush_scheduled = True
            self._flush_scheduled_at = now
            self._loop.add_callback(self._flush_pending)
        elif now - self._flush_scheduled_at >= INLINE_FLUSH_DELAY:
            # The queued flush is still waiting, so the loop is blocked.
            # It stays queued and picks up whatever comes after this.
            self._flush_pending_unlocked()
            self._flush_scheduled_at = now

    def _session_callback_added(self, event: Any) -> None:
        """Bokeh receiver for ``doc.add_next_tick_callback`` and friends.

        Without a Bokeh server nothing runs session callbacks, so schedule
        them on the kernel's IOLoop. Panel releases a ``hold()`` through a
        next tick callback, so without this its held changes never arrive.
        """
        if self._loop is not None and not self._closed:
            self._loop.add_callback(self._start_session_callback, event.callback)

    def _session_callback_removed(self, event: Any) -> None:
        if self._loop is not None:
            self._loop.add_callback(self._stop_session_callback, event.callback)

    def _start_session_callback(self, callback_obj: Any) -> None:
        from bokeh.server.callbacks import NextTickCallback, PeriodicCallback, TimeoutCallback
        from tornado.ioloop import PeriodicCallback as TornadoPeriodicCallback

        if (
            self._closed
            or callback_obj in self._session_callbacks
            or callback_obj not in self.document.session_callbacks
        ):
            return

        def run() -> Any:
            if (
                not self._closed
                and callback_obj in self._session_callbacks
                and callback_obj in self.document.session_callbacks
            ):
                return callback_obj.callback()
            return None

        loop = self._loop
        assert loop is not None
        if isinstance(callback_obj, PeriodicCallback):
            periodic = TornadoPeriodicCallback(run, callback_obj.period)
            periodic.start()
            self._session_callbacks[callback_obj] = periodic.stop
        elif isinstance(callback_obj, TimeoutCallback):
            handle = loop.call_later(callback_obj.timeout / 1000, run)
            self._session_callbacks[callback_obj] = lambda: loop.remove_timeout(handle)
        elif isinstance(callback_obj, NextTickCallback):
            self._session_callbacks[callback_obj] = lambda: None
            loop.add_callback(run)

    def _stop_session_callback(self, callback_obj: Any) -> None:
        cancel = self._session_callbacks.pop(callback_obj, None)
        if cancel is not None:
            cancel()

    def _cancel_session_callbacks(self) -> None:
        callbacks = self._session_callbacks
        self._session_callbacks = {}
        for cancel in callbacks.values():
            cancel()

    # ── Flushing ─────────────────────────────────────────────────────────

    def _ensure_open(self) -> None:
        if self._closed:
            raise BokehSessionClosedError(f"Bokeh session {self.session_id} is closed")

    def _end_transaction_unlocked(self) -> list[Any]:
        events = self._transaction_events
        self._active_setter = None
        self._transaction_events = []
        return events

    def _flush_pending(self) -> None:
        with self._lock:
            self._flush_scheduled = False
            self._flush_pending_unlocked()
            if (self._pending_events or self._fold_deferred()) and self._held():
                # A hold released without dispatch never schedules a flush.
                self._schedule_held_retry_unlocked()

    def _retry_held_flush(self) -> None:
        with self._lock:
            self._held_retry_scheduled = False
        self._flush_pending()

    def _schedule_held_retry_unlocked(self) -> None:
        if self._loop is None or self._closed or self._held_retry_scheduled:
            return
        self._held_retry_scheduled = True
        loop = self._loop
        # call_later is not thread-safe; add_callback is.
        loop.add_callback(lambda: loop.call_later(INLINE_FLUSH_DELAY, self._retry_held_flush))

    def _flush_pending_unlocked(self) -> None:
        """Publish pending events, then run folds deferred until the document was free."""
        if self._closed or not self._announced or self._busy_unlocked():
            return
        self._await_data_mutations_unlocked()
        # Waiting released the lock.
        if self._closed or self._busy_unlocked():
            return
        if self._pending_events:
            events = self._pending_events
            self._pending_events = []
            self._publish_unlocked(events, str(uuid.uuid4()))
        if self._fold_deferred() and not self._pending_events:
            self._fold_deferred_unlocked()

    def _publish_unlocked(
        self, events: list[Any], transaction_id: str, **kwargs: Any
    ) -> BokehDelta | None:
        """Build and deliver a delta; a failure is logged, never raised.

        The caller may be user code that only set a property. A failed build
        commits nothing, so its events go back to the front of the queue and
        the next flush retries them against unchanged versions.
        """
        try:
            delta = self._build_delta_unlocked(events, transaction_id, **kwargs)
        except Exception:  # noqa: BLE001
            log.exception("Could not build a Bokeh delta for session %s", self.session_id)
            self._pending_events[:0] = events
            return None
        if delta is not None:
            self._deliver_unlocked(delta)
        return delta

    def _held(self) -> bool:
        """Whether Bokeh is holding events for changes the graph already has.

        Flushing or folding then would publish models without the references
        to them, or fold data that a held stream later adds again. Unhold
        dispatches the events, which schedules the next flush.
        """
        return getattr(self.document.callbacks, "hold_value", None) is not None

    def _busy_unlocked(self) -> bool:
        """Held, or inside a foreign transaction whose events are not versioned yet."""
        return self._active_setter is not None or self._held()

    def _begin_data_mutation(self) -> None:
        # Taking the lock waits out a fold or build already encoding.
        with self._lock:
            self._data_mutations.add(threading.get_ident())

    def _end_data_mutation(self) -> None:
        with self._lock:
            self._data_mutations.discard(threading.get_ident())
            self._mutations_done.notify_all()

    def _await_data_mutations_unlocked(self) -> None:
        """Wait until no other thread is between changing ``source.data`` and its trigger.

        Encoding current columns in that window would send rows that the
        stream then adds again. No new window opens while the lock stays held.
        """
        me = threading.get_ident()
        self._mutations_done.wait_for(lambda: not (self._data_mutations - {me}))

    def _fold_deferred(self) -> bool:
        return self._deferred_fold_all or bool(self._deferred_folds)

    def _fold_deferred_unlocked(self) -> None:
        ids = set(self._deferred_folds)
        if self._deferred_fold_all:
            ids.update(sid for sid, state in self._sources.items() if state.bytes_since_fold)
        transaction_id = self._deferred_fold_transaction or str(uuid.uuid4())
        self._deferred_folds.clear()
        self._deferred_fold_all = False
        self._deferred_fold_transaction = None
        self._fold_unlocked(sorted(ids), transaction_id)

    def _deliver_unlocked(self, delta: BokehDelta) -> None:
        if self._event_sink is None:
            self._queued_deltas.append(delta)
            return
        try:
            self._event_sink(delta)
        except Exception:  # noqa: BLE001
            log.exception("Bokeh session event sink failed for %s", self.session_id)
            self._queued_deltas.append(delta)

    def _current_models(self) -> dict[str, Any]:
        models = self.document.models
        if getattr(models, "_freeze_count", 0):
            # Frozen mid-update: the manager has not recomputed reachability yet.
            current: dict[str, Any] = {}
            for root in self.document.roots:
                for model in root.references():
                    current[str(model.id)] = model
            return current
        return {str(model.id): model for model in models}

    def _meta(self) -> dict[str, Any]:
        return {
            "root_ids": [str(root.id) for root in self.document.roots],
            "title": self.document.title,
        }

    def _log_unencodable(self, what: str) -> None:
        log.warning(
            "Could not encode %s for Bokeh session %s; leaving it out",
            what,
            self.session_id,
            exc_info=True,
        )

    def _model_state(self, model: Any, serializer: Any) -> dict[str, Any]:
        from bokeh.core.json_encoder import serialize_json

        is_source = _is_column_source(model)
        props = {}
        for name, value in model.properties_with_values(include_defaults=False).items():
            if is_source and name == "data":
                continue
            try:
                props[name] = json.loads(serialize_json(serializer.encode(value)))
            except Exception:  # noqa: BLE001
                self._log_unencodable(f"{model.__qualified_model__}.{name} of {model.id}")
        return {
            "type": model.__qualified_model__,
            "ref_props": ref_props(type(model)),
            "props": props,
        }

    def _session_snapshot_unlocked(self, doc_json: Mapping[str, Any]) -> BokehSerialization:
        from bokeh.core.serialization import Serializer

        current = self._current_models()
        serializer = Serializer(references=set(current.values()), deferred=False)
        models = {mid: self._model_state(model, serializer) for mid, model in current.items()}
        encoded = _Encoded()
        data_events = []
        baseline = not self._announced
        if baseline:
            self._known_models = set(current)
            self._sources = {}
        for mid, model in current.items():
            if _is_column_source(model):
                state = self._sources.setdefault(mid, _SourceState())
                data_events.append(self._fold_event(mid, model, state, encoded, reset=baseline))
        extras = {k: v for k, v in doc_json.items() if k not in ("roots", "title", "version")}
        meta = {
            "session_id": self.session_id,
            "producer_name": self.producer_name,
            "producer_version": self.producer_version,
            "bokeh_version": self.bokeh_version,
            **self._meta(),
        }
        if extras:
            meta["doc_extras"] = extras
        content = {"meta": meta, "models": models, "data_events": data_events}
        return BokehSerialization(content=content, buffers=tuple(encoded.buffers))

    def _encode_columns(
        self, source: Any, names: Iterable[str], encoded: _Encoded
    ) -> tuple[dict[str, Any], dict[str, int]]:
        """Encode columns, leaving out (and logging) any that cannot be encoded."""
        columns: dict[str, Any] = {}
        sizes: dict[str, int] = {}
        for name in names:
            try:
                columns[name], sizes[name] = encoded.encode(source.data[name])
            except Exception:  # noqa: BLE001
                self._log_unencodable(f"column {name!r} of {source.id}")
        return columns, sizes

    def _fold_event(
        self,
        source_id: str,
        source: Any,
        state: _SourceState,
        encoded: _Encoded,
        *,
        reset: bool = True,
    ) -> dict[str, Any]:
        """Full columns at the current version, by default a new fold baseline."""
        columns, sizes = self._encode_columns(source, list(source.data), encoded)
        if reset:
            state.column_sizes = sizes
            state.bytes_since_fold = 0
        return {
            "kind": "ColumnsFolded",
            "source_id": source_id,
            "version": state.version,
            "columns": columns,
        }

    def _source_state(self, source_id: str) -> _SourceState:
        """A copy of a source's state, committed only once its delta is built."""
        state = self._sources.get(source_id)
        if state is None:
            return _SourceState()
        return replace(state, column_sizes=dict(state.column_sizes))

    def _fold_unlocked(self, source_ids: Sequence[str], transaction_id: str) -> list[str]:
        """Fold now; callers flushed first, so no stream or patch is unversioned."""
        current = self._current_models()
        folded = [sid for sid in source_ids if _is_column_source(current.get(sid))]
        if not folded:
            return []
        encoded = _Encoded()
        states = {sid: self._source_state(sid) for sid in folded}
        events = [self._fold_event(sid, current[sid], states[sid], encoded) for sid in folded]
        self._sources.update(states)
        self._deliver_unlocked(
            BokehDelta(
                session_id=self.session_id,
                transaction_id=transaction_id,
                data_events=events,
                buffers=tuple(encoded.buffers),
            )
        )
        return folded

    def _quiet_fold(self) -> None:
        with self._lock:
            self._quiet_fold_scheduled = False
            if self._closed or not self._announced:
                return
            self._flush_pending_unlocked()
            if self._pending_events or self._busy_unlocked():
                self._schedule_quiet_fold_unlocked()
                return
            now = time.monotonic()
            due = [
                sid
                for sid, state in self._sources.items()
                if state.bytes_since_fold and now - state.last_event_at >= FOLD_QUIET_SECONDS
            ]
            self._fold_unlocked(due, str(uuid.uuid4()))
            if any(state.bytes_since_fold for state in self._sources.values()):
                self._schedule_quiet_fold_unlocked()

    def _schedule_quiet_fold_unlocked(self) -> None:
        if self._loop is None or self._quiet_fold_scheduled:
            return
        self._quiet_fold_scheduled = True
        loop = self._loop
        # call_later is not thread-safe; add_callback is.
        loop.add_callback(lambda: loop.call_later(FOLD_QUIET_SECONDS, self._quiet_fold))

    def _build_delta_unlocked(
        self,
        events: Sequence[Any],
        transaction_id: str,
        *,
        requested: Mapping[str, Mapping[str, Any]] | None = None,
        requested_buffers: Sequence[BokehBuffer] = (),
        force_requested: bool = False,
    ) -> BokehDelta | None:
        """Turn recorded events into a delta.

        Session state (known models, source versions) changes only after the
        whole delta is built, so a failure leaves no version gap. Values that
        cannot be encoded are logged and left out rather than failing the delta.
        """
        from bokeh.core.json_encoder import serialize_json
        from bokeh.core.serialization import Serializer
        from bokeh.document.events import (
            ColumnDataChangedEvent,
            MessageSentEvent,
            ModelChangedEvent,
            RootAddedEvent,
            RootRemovedEvent,
            TitleChangedEvent,
        )

        current = self._current_models()
        added = [mid for mid in current if mid not in self._known_models]
        added_set = set(added)
        removed = sorted(self._known_models - set(current))
        serializer = Serializer(references=set(current.values()), deferred=False)

        def encode_json(value: Any) -> Any:
            return json.loads(serialize_json(serializer.encode(value)))

        touched: dict[str, set[str]] = {}
        replaced: dict[str, set[str] | None] = {}
        source_events: dict[str, list[_FrozenDataEvent]] = {}
        source_order: list[str] = []
        messages: list[dict[str, Any]] = []
        meta_changed = False
        encoded = _Encoded()

        for event in events:
            model = getattr(event, "model", None)
            mid = str(model.id) if model is not None else None
            if isinstance(event, _FrozenDataEvent):
                if mid in current and mid not in added_set and _is_column_source(model):
                    if mid not in source_events:
                        source_order.append(mid)
                    source_events.setdefault(mid, []).append(event)
            elif isinstance(event, ColumnDataChangedEvent | _ReplacedColumns) or (
                isinstance(event, ModelChangedEvent)
                and event.attr == "data"
                and _is_column_source(model)
            ):
                if mid in current and mid not in added_set:
                    if mid not in source_events:
                        source_order.append(mid)
                    source_events.setdefault(mid, [])
                    cols = getattr(event, "cols", None)
                    previous = replaced.get(mid, set())
                    if cols is None or previous is None:
                        replaced[mid] = None
                    else:
                        replaced[mid] = previous | set(cols)
            elif isinstance(event, ModelChangedEvent):
                if mid in current and mid not in added_set:
                    touched.setdefault(mid, set()).add(event.attr)
            elif isinstance(event, MessageSentEvent):
                try:
                    payload, _size = encoded.encode(event.msg_data, current.values())
                except Exception:  # noqa: BLE001
                    self._log_unencodable(f"message {event.msg_type!r}")
                    continue
                messages.append({"msg_type": event.msg_type, "msg_data": payload})
            elif isinstance(event, RootAddedEvent | RootRemovedEvent | TitleChangedEvent):
                meta_changed = True

        props_changed: dict[str, dict[str, Any]] = {}
        for mid, attrs in touched.items():
            model = current[mid]
            for attr in attrs:
                descriptor = model.lookup(attr, raises=False)
                if descriptor is None or not descriptor.serialized:
                    continue
                try:
                    props_changed.setdefault(mid, {})[attr] = encode_json(getattr(model, attr))
                except Exception:  # noqa: BLE001
                    self._log_unencodable(f"{model.__qualified_model__}.{attr} of {mid}")

        # Correction rule: a foreign value Python rejected or changed must be
        # written back even when Bokeh saw no change to report.
        matches = _RequestedMatcher(current.values(), requested_buffers)
        for mid, attrs in (requested or {}).items():
            model = current.get(mid)
            if model is None or mid in added_set:
                continue
            for attr, value in attrs.items():
                if model.lookup(attr, raises=False) is None:
                    continue
                try:
                    actual = encode_json(getattr(model, attr))
                except Exception:  # noqa: BLE001
                    self._log_unencodable(f"{model.__qualified_model__}.{attr} of {mid}")
                    continue
                if force_requested or not matches(model, attr, actual, value):
                    props_changed.setdefault(mid, {})[attr] = actual
        props_changed = {mid: props for mid, props in props_changed.items() if props}

        models_added = {mid: self._model_state(current[mid], serializer) for mid in added}

        data_events: list[dict[str, Any]] = []
        states: dict[str, _SourceState] = {}
        now = time.monotonic()
        for mid in added:
            if _is_column_source(current[mid]):
                state = states[mid] = _SourceState()
                data_events.append(self._fold_event(mid, current[mid], state, encoded))
        for mid in source_order:
            state = states[mid] = self._source_state(mid)
            data_events.extend(
                self._source_data_events(
                    mid, current[mid], state, source_events[mid], replaced, encoded, now
                )
            )
        meta = self._meta() if meta_changed else None

        # Session state changes only from here on.
        self._sources.update(states)
        for mid in removed:
            self._sources.pop(mid, None)
        self._known_models = set(current)
        with suppress(Exception):
            self.document.models.flush_synced()
        if any(state.bytes_since_fold for state in states.values()):
            self._schedule_quiet_fold_unlocked()

        delta = BokehDelta(
            session_id=self.session_id,
            transaction_id=transaction_id,
            models_added=models_added,
            props_changed=props_changed,
            models_removed=removed,
            data_events=data_events,
            messages=messages,
            meta=meta,
            buffers=tuple(encoded.buffers),
        )
        return None if delta.is_empty() else delta

    def _source_data_events(
        self,
        source_id: str,
        source: Any,
        state: _SourceState,
        events: Sequence[_FrozenDataEvent],
        replaced: Mapping[str, set[str] | None],
        encoded: _Encoded,
        now: float,
    ) -> list[dict[str, Any]]:
        current_columns = set(source.data)
        if source_id in replaced:
            # One replacement from current values subsumes this flush's streams
            # and patches. Streams and patches since the last fold also force
            # all columns, so the blobs again describe one version.
            requested_columns = replaced[source_id]
            if requested_columns is None or state.bytes_since_fold:
                columns = set(current_columns)
            else:
                columns = set(requested_columns)
                for event in events:
                    columns |= event.columns
            removed = sorted(set(state.column_sizes) - current_columns)
            payload, sizes = self._encode_columns(
                source, sorted(columns & current_columns), encoded
            )
            state.column_sizes.update(sizes)
            for name in removed:
                state.column_sizes.pop(name, None)
            base = state.version
            state.version += 1
            state.bytes_since_fold = 0
            return [
                {
                    "kind": "ColumnDataChanged",
                    "source_id": source_id,
                    "base_version": base,
                    "new_version": state.version,
                    "columns": payload,
                    "columns_removed": removed,
                }
            ]

        out: list[dict[str, Any]] = []
        for event in events:
            base = state.version
            state.version += 1
            data_event: dict[str, Any] = {
                "kind": event.kind,
                "source_id": source_id,
                "base_version": base,
                "new_version": state.version,
            }
            if event.kind == "ColumnsStreamed":
                data_event["data"] = event.payload
                data_event["rollover"] = event.rollover
            else:
                data_event["patches"] = event.payload
            if event.echo_of is not None:
                # The originating peer applied this edit already.
                data_event["echo_of"] = event.echo_of
            out.append(data_event)
            encoded.buffers.extend(event.buffers)
            state.bytes_since_fold += event.size
            state.last_event_at = now
        if state.bytes_since_fold >= FOLD_BYTE_RATIO * state.fold_size:
            out.append(self._fold_event(source_id, source, state, encoded))
        return out


class BokehSessionRegistry:
    """Thread-safe process-local ownership of live document sessions."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, BokehDocumentSession] = {}
        self._event_sink: Callable[[BokehDelta], None] | None = None

    def set_event_sink(self, sink: Callable[[BokehDelta], None] | None) -> None:
        with self._lock:
            self._event_sink = sink
            sessions = list(self._sessions.values())
        for session in sessions:
            session.set_event_sink(sink)

    @property
    def live(self) -> bool:
        """Whether deltas have somewhere to go, so a new session can be announced live.

        Only a complete kernel-hook install sets the sink, which also routes
        peer patches back to the sessions.
        """
        with self._lock:
            return self._event_sink is not None

    def register(self, session: BokehDocumentSession) -> None:
        with self._lock:
            if session.session_id in self._sessions:
                raise BokehSessionError(f"duplicate Bokeh session id: {session.session_id}")
            session.set_event_sink(self._event_sink)
            self._sessions[session.session_id] = session

    def get(self, session_id: str) -> BokehDocumentSession | None:
        with self._lock:
            return self._sessions.get(session_id)

    def require(self, session_id: str) -> BokehDocumentSession:
        session = self.get(session_id)
        if session is None:
            raise BokehSessionError(f"unknown Bokeh session id: {session_id}")
        return session

    def close(self, session_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        session.close()
        return True

    def clear(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.close()

    def __len__(self) -> int:
        with self._lock:
            return len(self._sessions)


session_registry = BokehSessionRegistry()
