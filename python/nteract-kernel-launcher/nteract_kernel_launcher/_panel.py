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
from nteract_kernel_launcher._buffer_hook import pending_buffers
from nteract_kernel_launcher._refs import BLOB_REF_MIME

log = logging.getLogger("nteract_kernel_launcher")

_PANEL_VIEWABLE_TYPE = "panel.viewable.Viewable"
_PANEL_LOAD_MIME = "application/vnd.holoviews_load.v0+json"
_PANEL_EXEC_MIME = "application/vnd.holoviews_exec.v0+json"
_PANEL_FALLBACK_METADATA = "application/vnd.nteract.panel-fallback.v1+json"
_PANEL_AUTOLOAD_MARKER = r"const PN_RE = /^https:\/\/cdn\.holoviz\.org\/panel"
_PYVIZ_MANAGER_MARKER = "hv-extension-comm"
_installed_formatters: weakref.WeakKeyDictionary[Any, tuple[Callable[..., Any], Any]] = (
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

    _nteract_installed = True
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


def _install_bootstrap_filter(ip: Any) -> None:
    for publisher in (getattr(ip, "display_pub", None), getattr(ip, "displayhook", None)):
        if publisher is None:
            continue
        hooks = list(getattr(publisher, "_hooks", []))
        if any(getattr(hook, "_nteract_panel_bootstrap_filter", False) for hook in hooks):
            continue
        register = getattr(publisher, "register_hook", None)
        if register is not None:
            register(_PanelBootstrapFilter())


def _uninstall_bootstrap_filter(ip: Any) -> None:
    for publisher in (getattr(ip, "display_pub", None), getattr(ip, "displayhook", None)):
        if publisher is None:
            continue
        unregister = getattr(publisher, "unregister_hook", None)
        if unregister is None:
            continue
        for hook in list(getattr(publisher, "_hooks", [])):
            if getattr(hook, "_nteract_panel_bootstrap_filter", False):
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
    from panel.io.model import add_to_doc, monkeypatch_events
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
        event_transform=monkeypatch_events,
        cleanup=_panel_cleanup(viewable, root, document),
    )
    return session, resources, bokeh.__version__


def _stash_buffers(
    serialized: BokehSerialization,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    descriptors = serialized.buffer_descriptors()
    refs: list[dict[str, Any]] = []
    pending = pending_buffers()
    for descriptor, buffer in zip(descriptors, serialized.buffers, strict=True):
        pending[descriptor["hash"]] = buffer.data
        refs.append(
            {
                "hash": descriptor["hash"],
                "size": descriptor["size"],
                "content_type": "application/octet-stream",
                "buffer_index": descriptor["buffer_index"],
            }
        )
    return descriptors, refs


def _plain_text(viewable: Any) -> str:
    text = repr(viewable)
    return text if len(text) <= 240 else f"{text[:237]}..."


def _native_panel_mimebundle(viewable: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not _panel_extension_loaded():
        raise RuntimeError("Panel extension is not loaded")

    session, resources, bokeh_version = _create_panel_session(viewable)
    stashed_hashes: set[str] = set()
    try:
        snapshot = session.snapshot()
        buffer_descriptors, refs = _stash_buffers(snapshot)
        stashed_hashes = {ref["hash"] for ref in refs}
        payload = {
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session.session_id,
            "revision": session.revision,
            "producer": {
                "name": session.producer_name,
                "version": session.producer_version,
            },
            "bokeh_version": bokeh_version,
            "document": snapshot.content,
            "root_ids": session.root_ids,
            "resources": resources,
            "buffers": buffer_descriptors,
        }
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
        session_registry.register(session)
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


def install(ip: Any) -> None:
    _install_bootstrap_filter(ip)
    formatter = ip.display_formatter.mimebundle_formatter
    if formatter in _installed_formatters:
        return

    previous = formatter.for_type(_PANEL_VIEWABLE_TYPE)

    def panel_formatter(viewable: Any) -> Any:
        return _format_panel(viewable, previous)

    panel_formatter._nteract_panel_formatter = True
    formatter.for_type(_PANEL_VIEWABLE_TYPE, panel_formatter)
    _installed_formatters[formatter] = (panel_formatter, previous)


def uninstall(ip: Any) -> None:
    _uninstall_bootstrap_filter(ip)
    formatter = ip.display_formatter.mimebundle_formatter
    installed = _installed_formatters.pop(formatter, None)
    if installed is not None:
        panel_formatter, previous = installed
        try:
            current = formatter.lookup_by_type(_PANEL_VIEWABLE_TYPE)
        except KeyError:
            current = None
        if current is panel_formatter:
            formatter.pop(_PANEL_VIEWABLE_TYPE, None)
            if previous is not None:
                formatter.for_type(_PANEL_VIEWABLE_TYPE, previous)
    session_registry.clear()
