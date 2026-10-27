"""Panel adapter for nteract Bokeh document sessions.

This module is imported during launcher bootstrap, but it never imports Panel
or Bokeh until IPython formats an actual ``panel.viewable.Viewable``.
"""

from __future__ import annotations

import logging
import sys
import weakref
from collections.abc import Callable
from typing import Any

from nteract_kernel_launcher._bokeh_session import (
    BOKEH_SESSION_MIME,
    BOKEH_SESSION_SCHEMA_VERSION,
    BokehDocumentSession,
    BokehSerialization,
    session_registry,
)
from nteract_kernel_launcher._buffer_hook import _get_ipython, pending_buffers
from nteract_kernel_launcher._refs import BLOB_REF_MIME

log = logging.getLogger("nteract_kernel_launcher")

_PANEL_VIEWABLE_TYPE = "panel.viewable.Viewable"
_PANEL_VIEWER_TYPE = "panel.viewable.Viewer"
_PANEL_LOAD_MIME = "application/vnd.holoviews_load.v0+json"
_PANEL_EXEC_MIME = "application/vnd.holoviews_exec.v0+json"
_PANEL_FALLBACK_METADATA = "application/vnd.nteract.panel-fallback.v1+json"
_PANEL_AUTOLOAD_MARKER = r"const PN_RE = /^https:\/\/cdn\.holoviz\.org\/panel"
_PYVIZ_MANAGER_MARKER = "hv-extension-comm"
_installed_formatters: weakref.WeakKeyDictionary[Any, dict[str, tuple[Callable[..., Any], Any]]] = (
    weakref.WeakKeyDictionary()
)


def _strip_marked_panel_fallback(
    msg: dict[str, Any], content: dict[str, Any]
) -> dict[str, Any] | None:
    metadata = content.get("metadata")
    if not isinstance(metadata, dict) or not metadata.get(_PANEL_FALLBACK_METADATA):
        return None
    filtered_metadata = dict(metadata)
    filtered_metadata.pop(_PANEL_FALLBACK_METADATA, None)
    return {**msg, "content": {**content, "metadata": filtered_metadata}}


def _is_panel_browser_info_output(content: dict[str, Any]) -> bool:
    metadata = content.get("metadata")
    if not isinstance(metadata, dict):
        return False
    exec_metadata = metadata.get(_PANEL_EXEC_MIME)
    if not isinstance(exec_metadata, dict):
        return False
    root_id = exec_metadata.get("id")
    if not isinstance(root_id, str):
        return False

    state_module = sys.modules.get("panel.io.state")
    panel_state = getattr(state_module, "state", None)
    views = getattr(panel_state, "_views", None)
    if not isinstance(views, dict):
        return False
    view = views.get(root_id)
    return (
        isinstance(view, tuple)
        and len(view) > 0
        and view[0] is getattr(panel_state, "_browser", None)
    )


def _without_legacy_panel_load(
    msg: dict[str, Any], content: dict[str, Any], data: dict[str, Any]
) -> dict[str, Any] | None:
    filtered_data = dict(data)
    bootstrap = filtered_data.pop(_PANEL_LOAD_MIME)
    if filtered_data.get("application/javascript") == bootstrap:
        filtered_data.pop("application/javascript")
    if not filtered_data:
        return None

    filtered_content = dict(content)
    filtered_content["data"] = filtered_data
    metadata = content.get("metadata")
    if isinstance(metadata, dict) and _PANEL_LOAD_MIME in metadata:
        filtered_metadata = dict(metadata)
        filtered_metadata.pop(_PANEL_LOAD_MIME, None)
        filtered_content["metadata"] = filtered_metadata
    return {**msg, "content": filtered_content}


class _PanelBootstrapFilter:
    """Suppress only the bootstrap outputs emitted by ``pn.extension()``.

    HoloViews shares Panel's legacy load/exec MIME names. The filter therefore
    recognizes Panel's autoloader, suppresses only the immediately following
    PyViz manager payload, and resolves the hidden browser-info output through
    Panel's own view registry. Other HoloViews and Panel outputs pass through.
    """

    _nteract_panel_bootstrap_filter = True

    def __init__(self) -> None:
        self._awaiting_pyviz_manager = False

    def __call__(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        content = msg.get("content")
        if not isinstance(content, dict):
            return msg
        data = content.get("data")
        if not isinstance(data, dict):
            return msg
        fallback = _strip_marked_panel_fallback(msg, content)
        if fallback is not None:
            return fallback
        if _PANEL_EXEC_MIME in data:
            if _is_panel_browser_info_output(content):
                return None
            return msg
        if _PANEL_LOAD_MIME not in data:
            return msg

        code = data.get(_PANEL_LOAD_MIME)
        is_panel_autoload = isinstance(code, str) and _PANEL_AUTOLOAD_MARKER in code
        is_panel_manager = (
            self._awaiting_pyviz_manager and isinstance(code, str) and _PYVIZ_MANAGER_MARKER in code
        )
        self._awaiting_pyviz_manager = is_panel_autoload
        if not is_panel_autoload and not is_panel_manager:
            return msg
        return _without_legacy_panel_load(msg, content, data)


def _announced_session(msg: dict[str, Any]) -> BokehDocumentSession | None:
    content = msg.get("content")
    data = content.get("data") if isinstance(content, dict) else None
    payload = data.get(BOKEH_SESSION_MIME) if isinstance(data, dict) else None
    session_id = payload.get("session_id") if isinstance(payload, dict) else None
    if not isinstance(session_id, str):
        return None
    session = session_registry.get(session_id)
    return session if session is not None and not session.announced else None


class _SessionAnnouncer:
    """Send a session's display message, then let the session publish deltas.

    Deltas published before the display message would reach the runtime for
    a session it does not know yet, so this hook runs the rest of the chain
    and the send itself, and only then marks the session announced.
    """

    _nteract_bokeh_session_announcer = True

    def __init__(self, publisher: Any) -> None:
        self._publisher = publisher

    def __call__(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        session = _announced_session(msg)
        if session is None:
            return msg
        try:
            hooks = list(self._publisher._hooks)
            following = hooks[hooks.index(self) + 1 :] if self in hooks else []
            outgoing: dict[str, Any] | None = msg
            for hook in following:
                outgoing = hook(outgoing)
                if outgoing is None:
                    break
            if outgoing is not None:
                self._publisher.session.send(
                    self._publisher.pub_socket, outgoing, ident=self._publisher.topic
                )
        finally:
            session.mark_announced()
        return None


def _install_session_announcer(publisher: Any) -> None:
    hooks = getattr(publisher, "_hooks", None)
    if not isinstance(hooks, list):
        return
    if any(getattr(hook, "_nteract_bokeh_session_announcer", False) for hook in hooks):
        return
    # First, so a hook that sends the message itself cannot skip it.
    hooks.insert(0, _SessionAnnouncer(publisher))


def _publishers(ip: Any) -> list[Any]:
    return [
        publisher
        for publisher in (getattr(ip, "display_pub", None), getattr(ip, "displayhook", None))
        if publisher is not None
    ]


def _install_bootstrap_filter(ip: Any) -> None:
    for publisher in _publishers(ip):
        _install_session_announcer(publisher)
        hooks = list(getattr(publisher, "_hooks", []))
        if any(getattr(hook, "_nteract_panel_bootstrap_filter", False) for hook in hooks):
            continue
        register = getattr(publisher, "register_hook", None)
        if register is not None:
            register(_PanelBootstrapFilter())


def _uninstall_bootstrap_filter(ip: Any) -> None:
    for publisher in _publishers(ip):
        unregister = getattr(publisher, "unregister_hook", None)
        if unregister is None:
            continue
        for hook in list(getattr(publisher, "_hooks", [])):
            if getattr(hook, "_nteract_panel_bootstrap_filter", False) or getattr(
                hook, "_nteract_bokeh_session_announcer", False
            ):
                unregister(hook)


def _panel_extension_loaded() -> bool:
    from panel.config import panel_extension

    if panel_extension._loaded:
        return True
    holoviews = sys.modules.get("holoviews")
    extension = getattr(holoviews, "extension", None)
    return bool(getattr(extension, "_loaded", False))


def _resource_url(value: Any) -> str:
    return str(getattr(value, "url", value))


def _resource_entries(
    files: list[Any],
    raw: list[str],
    hashes: dict[str, str],
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for value in files:
        url = _resource_url(value)
        key = ("url", url)
        if key in seen:
            continue
        seen.add(key)
        entry: dict[str, Any] = {"kind": "url", "url": url}
        if url in hashes:
            entry["integrity"] = f"sha384-{hashes[url]}"
        entries.append(entry)
    for code in raw:
        key = ("inline", code)
        if key in seen:
            continue
        seen.add(key)
        entries.append({"kind": "inline", "code": code})
    return entries


def _panel_resources(roots: list[Any], mode: str) -> dict[str, Any]:
    from panel.io.resources import Resources, bundle_resources

    resources = Resources(mode=mode, notebook=True)
    bundle = bundle_resources(roots, resources, notebook=True)
    hashes = dict(getattr(bundle, "hashes", {}))
    return {
        "javascript": _resource_entries(bundle.js_files, bundle.js_raw, hashes),
        "stylesheets": _resource_entries(bundle.css_files, bundle.css_raw, {}),
        "javascript_modules": [
            {"kind": "module", "url": _resource_url(module)}
            for module in getattr(bundle, "js_modules", [])
        ],
        "module_exports": {
            str(name): _resource_url(module)
            for name, module in getattr(bundle, "js_module_exports", {}).items()
        },
    }


def _panel_cleanup(viewable: Any, root: Any, document: Any) -> Callable[[], None]:
    def cleanup() -> None:
        from panel.io.state import state

        try:
            viewable._cleanup(root)
        finally:
            state._views.pop(root.ref["id"], None)
            document.clear()

    return cleanup


def _create_panel_session(viewable: Any) -> tuple[BokehDocumentSession, dict[str, Any], str]:
    import bokeh
    import panel
    from bokeh.document import Document
    from panel.config import config
    from panel.io.model import add_to_doc
    from panel.io.resources import set_resource_mode

    document = Document()
    mode = "inline" if config.inline else "cdn"
    with set_resource_mode(mode):
        root = viewable.get_root(doc=document, comm=None)
        add_to_doc(root, document)

    design = getattr(viewable, "_design", None)
    theme = getattr(getattr(design, "theme", None), "bokeh_theme", None)
    if theme is not None:
        document.theme = theme

    resources = _panel_resources([root], mode)
    session = BokehDocumentSession(
        document,
        [root],
        producer_name="panel",
        producer_version=panel.__version__,
        cleanup=_panel_cleanup(viewable, root, document),
        announced=False,
    )
    return session, resources, bokeh.__version__


def _mark_document_loaded(document: Any) -> None:
    """Tell Panel the client now holds this Document.

    Panel drops model changes made inside ``hold()`` while no client has the
    Document, expecting a later full serialization to carry them. The
    snapshot is that serialization, so mark the Document loaded the way a
    connecting Panel session does. Components that update inside a hold,
    such as ``ReactiveESM`` subclasses, otherwise never emit events.
    """
    from panel.io.state import state

    state._on_load(document)


def _stash_buffers(
    document: BokehSerialization, session_doc: BokehSerialization | None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Wire descriptors for both serializations and the blob refs they index.

    The session state holds the same column bytes as the DocJson, so its
    buffers point at the DocJson's frames instead of sending them twice.
    """
    refs: list[dict[str, Any]] = []
    index_by_hash: dict[str, int] = {}
    pending = pending_buffers()

    def add_ref(buffer: Any) -> int:
        index = len(refs)
        index_by_hash.setdefault(buffer.sha256, index)
        pending[buffer.sha256] = buffer.data
        refs.append(
            {
                "hash": buffer.sha256,
                "size": len(buffer.data),
                "content_type": "application/octet-stream",
                "buffer_index": index,
            }
        )
        return index

    document_descriptors = [buffer.descriptor(add_ref(buffer)) for buffer in document.buffers]
    session_descriptors = [
        buffer.descriptor(
            index_by_hash[buffer.sha256] if buffer.sha256 in index_by_hash else add_ref(buffer)
        )
        for buffer in (session_doc.buffers if session_doc is not None else ())
    ]
    return document_descriptors, session_descriptors, refs


def _plain_text(viewable: Any) -> str:
    text = repr(viewable)
    return text if len(text) <= 240 else f"{text[:237]}..."


def _native_panel_mimebundle(viewable: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not _panel_extension_loaded():
        raise RuntimeError("Panel extension is not loaded")

    # Without a delta sink nothing would publish Python changes or route peer
    # patches back, so the output carries no `session_doc` and renders static.
    live = session_registry.live
    session, resources, bokeh_version = _create_panel_session(viewable)
    stashed_hashes: set[str] = set()
    try:
        checkpoint = session.checkpoint()
        if live:
            # Changes from onload callbacks stay pending until the display
            # message announcing the session has been sent.
            _mark_document_loaded(session.document)
        session_doc = checkpoint.session_doc if live else None
        document_buffers, session_doc_buffers, refs = _stash_buffers(
            checkpoint.document, session_doc
        )
        stashed_hashes = {ref["hash"] for ref in refs}
        payload: dict[str, Any] = {
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session.session_id,
            "producer": {
                "name": session.producer_name,
                "version": session.producer_version,
            },
            "bokeh_version": bokeh_version,
            "document": checkpoint.document.content,
            "root_ids": session.root_ids,
            "resources": resources,
            "buffers": document_buffers,
        }
        if session_doc is not None:
            payload["session_doc"] = session_doc.content
            payload["session_doc_buffers"] = session_doc_buffers
        data: dict[str, Any] = {
            BOKEH_SESSION_MIME: payload,
            "text/plain": _plain_text(viewable),
        }
        if refs:
            data[BLOB_REF_MIME] = {"refs": refs}
        metadata = {
            BOKEH_SESSION_MIME: {
                "session_id": session.session_id,
                "isolated": True,
            }
        }
        if not live:
            session.close()
            return data, metadata
        session_registry.register(session)
        ip = _get_ipython()
        if ip is not None:
            # Publisher hooks are thread-local and display() may run on a worker.
            for publisher in _publishers(ip):
                _install_session_announcer(publisher)
        return data, metadata
    except Exception:
        pending = pending_buffers()
        for content_hash in stashed_hashes:
            pending.pop(content_hash, None)
        session.close()
        raise


def _fallback_mimebundle(viewable: Any, fallback: Callable[[Any], Any] | None) -> Any:
    if fallback is not None:
        return fallback(viewable)
    method = getattr(viewable, "_repr_mimebundle_", None)
    return method() if method is not None else None


def _mark_panel_fallback(bundle: Any) -> Any:
    if bundle is None:
        return None
    if isinstance(bundle, tuple):
        data, metadata = bundle
    else:
        data, metadata = bundle, {}
    marked_metadata = dict(metadata or {})
    marked_metadata[_PANEL_FALLBACK_METADATA] = True
    return data, marked_metadata


def _format_panel(viewable: Any, fallback: Callable[[Any], Any] | None) -> Any:
    try:
        return _native_panel_mimebundle(viewable)
    except Exception as exc:  # noqa: BLE001
        log.warning("native Panel document session failed; using Panel fallback: %s", exc)
        return _mark_panel_fallback(_fallback_mimebundle(viewable, fallback))


def _format_viewer(viewer: Any, fallback: Callable[[Any], Any] | None) -> Any:
    """Render a ``Viewer`` natively.

    ``Viewer._repr_mimebundle_`` renders its view through Panel's own Jupyter
    path, bypassing the formatter registered for ``Viewable``.
    """
    from panel import panel

    try:
        return _native_panel_mimebundle(panel(viewer))
    except Exception as exc:  # noqa: BLE001
        log.warning("native Panel document session failed; using Panel fallback: %s", exc)
        return _mark_panel_fallback(_fallback_mimebundle(viewer, fallback))


def install(ip: Any) -> None:
    _install_bootstrap_filter(ip)
    formatter = ip.display_formatter.mimebundle_formatter
    if formatter in _installed_formatters:
        return

    installed: dict[str, tuple[Callable[..., Any], Any]] = {}
    for type_name, format_object in (
        (_PANEL_VIEWABLE_TYPE, _format_panel),
        (_PANEL_VIEWER_TYPE, _format_viewer),
    ):
        previous = formatter.for_type(type_name)

        def panel_formatter(obj: Any, format_object=format_object, previous=previous) -> Any:
            return format_object(obj, previous)

        panel_formatter._nteract_panel_formatter = True
        formatter.for_type(type_name, panel_formatter)
        installed[type_name] = (panel_formatter, previous)
    _installed_formatters[formatter] = installed


def uninstall(ip: Any) -> None:
    _uninstall_bootstrap_filter(ip)
    formatter = ip.display_formatter.mimebundle_formatter
    installed = _installed_formatters.pop(formatter, {})
    for type_name, (panel_formatter, previous) in installed.items():
        try:
            current = formatter.lookup_by_type(type_name)
        except KeyError:
            current = None
        if current is panel_formatter:
            formatter.pop(type_name, None)
            if previous is not None:
                formatter.for_type(type_name, previous)
    session_registry.clear()
