"""Kernel-owned Bokeh document sessions.

The launcher keeps Bokeh's document and patch model intact. Producer adapters
such as Panel create a document and roots; this module owns serialization,
revision ordering, and the process-local lifetime of the live callback graph.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import uuid
from collections.abc import Callable, Iterable, Sequence
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("nteract_kernel_launcher")

BOKEH_SESSION_MIME = "application/vnd.nteract.bokeh-session.v1+json"
BOKEH_SESSION_SCHEMA_VERSION = 1


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
class BokehPatchResult:
    transaction_id: str
    base_revision: int
    revision: int
    derived: BokehSerialization | None


@dataclass(frozen=True)
class BokehServerEvent:
    session_id: str
    transaction_id: str
    base_revision: int
    revision: int
    client_patch: BokehSerialization | None
    server_patch: BokehSerialization | None
    checkpoint: BokehSerialization | None = None


class BokehSessionError(RuntimeError):
    pass


class BokehSessionClosedError(BokehSessionError):
    pass


class StaleBokehRevisionError(BokehSessionError):
    def __init__(self, expected: int, actual: int) -> None:
        self.expected = expected
        self.actual = actual
        super().__init__(f"stale Bokeh revision: expected {expected}, current revision is {actual}")


class BokehPatchApplyError(BokehSessionError):
    """Patch application failed after the document may have partially changed.

    Bokeh document mutation is not transactional. The revision is advanced and
    a checkpoint is attached so the runtime can replace speculative browser
    state instead of pretending the failed patch was rolled back.
    """

    def __init__(
        self,
        message: str,
        *,
        transaction_id: str,
        revision: int,
        checkpoint: BokehSerialization,
    ) -> None:
        self.transaction_id = transaction_id
        self.revision = revision
        self.checkpoint = checkpoint
        super().__init__(message)


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


def _replayable_client_patch(
    patch: dict[str, Any], buffers: Sequence[BokehBuffer]
) -> BokehSerialization | None:
    """Keep client document mutations while excluding ephemeral messages.

    Bokeh sends user and lifecycle events as ``MessageSent`` patch events so
    the Python document can run callbacks. Replaying those ephemeral events can
    run callbacks again and must not enter the durable replay log. Model, root,
    title, and column-data mutations remain replayable.
    """
    events = patch.get("events")
    if not isinstance(events, list):
        return BokehSerialization(content=patch, buffers=tuple(buffers))
    replayable = [
        event
        for event in events
        if not (isinstance(event, dict) and event.get("kind") == "MessageSent")
    ]
    if not replayable:
        return None
    content = patch if len(replayable) == len(events) else {**patch, "events": replayable}
    return BokehSerialization(content=content, buffers=tuple(buffers))


class BokehDocumentSession:
    """A live Bokeh document with one serialized revision authority."""

    def __init__(
        self,
        document: Any,
        roots: Sequence[Any],
        *,
        producer_name: str,
        producer_version: str,
        session_id: str | None = None,
        event_transform: Callable[[list[Any]], None] | None = None,
        cleanup: Callable[[], None] | None = None,
        event_sink: Callable[[BokehServerEvent], None] | None = None,
    ) -> None:
        self.session_id = session_id or str(uuid.uuid4())
        self.document = document
        self.roots = tuple(roots)
        self.producer_name = producer_name
        self.producer_version = producer_version
        self._event_transform = event_transform
        self._cleanup = cleanup
        self._event_sink = event_sink
        self._lock = threading.RLock()
        self._revision = 0
        self._active_setter: str | None = None
        self._transaction_events: list[Any] = []
        self._queued_server_events: list[BokehServerEvent] = []
        self._closed = False
        self.document.on_change_dispatch_to(self)

    @property
    def revision(self) -> int:
        with self._lock:
            return self._revision

    @property
    def root_ids(self) -> list[str]:
        return [str(root.id) for root in self.roots]

    def set_event_sink(self, sink: Callable[[BokehServerEvent], None] | None) -> None:
        with self._lock:
            self._event_sink = sink

    def snapshot(self) -> BokehSerialization:
        with self._lock:
            self._ensure_open()
            return self._snapshot_unlocked()

    def _snapshot_unlocked(self) -> BokehSerialization:
        return _serialize_bokeh_value(self.document.to_json())

    def apply_patch(
        self,
        *,
        base_revision: int,
        patch: dict[str, Any],
        buffers: Sequence[BokehBuffer] = (),
        transaction_id: str | None = None,
    ) -> BokehPatchResult:
        """Apply one browser patch and collect callback-derived document events."""
        from bokeh.core.serialization import Buffer, Serialized
        from bokeh.core.types import ID

        transaction_id = transaction_id or str(uuid.uuid4())
        with self._lock:
            self._ensure_open()
            if base_revision != self._revision:
                raise StaleBokehRevisionError(base_revision, self._revision)

            setter = f"nteract:{self.session_id}:{transaction_id}"
            self._active_setter = setter
            self._transaction_events = []
            serialized_patch: Any = patch
            if buffers:
                serialized_patch = Serialized(
                    content=patch,
                    buffers=[Buffer(ID(buffer.id), buffer.data) for buffer in buffers],
                )

            try:
                self.document.apply_json_patch(serialized_patch, setter=setter)
            except Exception as exc:
                self._active_setter = None
                self._transaction_events = []
                base_revision = self._revision
                self._revision += 1
                checkpoint = self._snapshot_unlocked()
                self._deliver_event_unlocked(
                    BokehServerEvent(
                        session_id=self.session_id,
                        transaction_id=transaction_id,
                        base_revision=base_revision,
                        revision=self._revision,
                        client_patch=None,
                        server_patch=None,
                        checkpoint=checkpoint,
                    )
                )
                raise BokehPatchApplyError(
                    str(exc),
                    transaction_id=transaction_id,
                    revision=self._revision,
                    checkpoint=checkpoint,
                ) from exc

            derived_events = self._transaction_events
            self._active_setter = None
            self._transaction_events = []
            self._revision += 1
            derived = self._serialize_events_unlocked(derived_events)
            result = BokehPatchResult(
                transaction_id=transaction_id,
                base_revision=base_revision,
                revision=self._revision,
                derived=derived,
            )
            self._deliver_event_unlocked(
                BokehServerEvent(
                    session_id=self.session_id,
                    transaction_id=transaction_id,
                    base_revision=base_revision,
                    revision=self._revision,
                    client_patch=_replayable_client_patch(patch, buffers),
                    server_patch=derived,
                    checkpoint=None,
                )
            )
            return result

    def pop_server_events(self) -> list[BokehServerEvent]:
        with self._lock:
            events = self._queued_server_events
            self._queued_server_events = []
            return events

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._event_sink = None
            self._queued_server_events = []
            self._transaction_events = []
            cleanup = self._cleanup

        with suppress(KeyError, ValueError):
            self.document.remove_on_change(self)
        if cleanup is not None:
            try:
                cleanup()
            except Exception:  # noqa: BLE001
                log.exception("Bokeh session cleanup failed for %s", self.session_id)

    def _ensure_open(self) -> None:
        if self._closed:
            raise BokehSessionClosedError(f"Bokeh session {self.session_id} is closed")

    def _serialize_events_unlocked(self, events: Iterable[Any]) -> BokehSerialization | None:
        from bokeh.core.serialization import Serialized, Serializer
        from bokeh.document.events import DocumentPatchedEvent

        patch_events = [event for event in events if isinstance(event, DocumentPatchedEvent)]
        if not patch_events:
            return None
        if self._event_transform is not None:
            self._event_transform(patch_events)

        serializer = Serializer(
            references=self.document.models.synced_references,
            deferred=True,
        )
        serialized = _serialize_bokeh_value(
            Serialized(
                content={"events": serializer.encode(patch_events)},
                buffers=serializer.buffers,
            )
        )
        self.document.models.flush_synced(lambda model: not serializer.has_ref(model))
        return serialized

    def _document_patched(self, event: Any) -> None:
        """Bokeh callback receiver used by ``on_change_dispatch_to``."""
        with self._lock:
            if self._closed or (
                self._active_setter is not None and event.setter == self._active_setter
            ):
                return
            if self._active_setter is not None:
                self._transaction_events.append(event)
                return

            patch = self._serialize_events_unlocked([event])
            if patch is None:
                return
            self._revision += 1
            server_event = BokehServerEvent(
                session_id=self.session_id,
                transaction_id=str(uuid.uuid4()),
                base_revision=self._revision - 1,
                revision=self._revision,
                client_patch=None,
                server_patch=patch,
                checkpoint=None,
            )
            self._deliver_event_unlocked(server_event)

    def _deliver_event_unlocked(self, event: BokehServerEvent) -> None:
        if self._event_sink is None:
            self._queued_server_events.append(event)
            return
        try:
            self._event_sink(event)
        except Exception:  # noqa: BLE001
            log.exception("Bokeh session event sink failed for %s", self.session_id)
            self._queued_server_events.append(event)


class BokehSessionRegistry:
    """Thread-safe process-local ownership of live document sessions."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, BokehDocumentSession] = {}
        self._event_sink: Callable[[BokehServerEvent], None] | None = None

    def set_event_sink(self, sink: Callable[[BokehServerEvent], None] | None) -> None:
        with self._lock:
            self._event_sink = sink
            sessions = list(self._sessions.values())
        for session in sessions:
            session.set_event_sink(sink)

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
