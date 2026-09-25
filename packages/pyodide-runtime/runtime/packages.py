"""Offline micropip planning and installation. Neither operation opens a socket.

The planner runs in a fresh interpreter which never receives notebook source.
It yields missing artifact URLs to the trusted provider, which owns acquisition
and independently validates origins, hashes, sizes, and resource budgets.
"""

import base64
import hashlib
import importlib.metadata
import io
import json
import zipfile
from pathlib import Path

import micropip
from micropip import wheelinfo
from micropip._compat import compatibility_layer
from micropip._vendored.packaging.src.packaging.markers import default_environment
from micropip._vendored.packaging.src.packaging.requirements import Requirement
from micropip._vendored.packaging.src.packaging.utils import canonicalize_name
from micropip.transaction import Transaction

_artifacts = {}


class MissingArtifact(BaseException):
    pass


def _validate_wheel(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 4000 or sum(entry.file_size for entry in entries) > 64 * 1024 * 1024:
            raise ValueError("wheel_limit")
        for entry in entries:
            parts = Path(entry.filename).parts
            if (
                entry.filename.startswith("/")
                or ".." in parts
                or "\\" in entry.filename
                or entry.filename.endswith((".so", ".dll", ".dylib", ".wasm", ".pth"))
                or (entry.external_attr >> 16) & 0o170000 == 0o120000
            ):
                raise ValueError("unsupported_wheel")


async def _fetch_bytes(url, _kwargs):
    resource = _artifacts.get(url)
    if resource is None:
        raise MissingArtifact(url)
    data = base64.b64decode(resource["body"])
    _validate_wheel(data)
    return data


class OfflineCompatibility(compatibility_layer):
    # Included packages are already installed in the clean planner. Everything
    # else must resolve through the trusted, filtered PyPI metadata supplied here.
    lockfile_packages = {}

    @staticmethod
    async def fetch_string_and_headers(url, _kwargs):
        resource = _artifacts.get(url)
        if resource is None:
            raise MissingArtifact(url)
        return resource["body"], {"content-type": "application/json"}


class OfflineTransaction(Transaction):
    async def gather_requirements(self, requirements):
        # No pending gather tasks survive a missing-artifact response. Planning
        # can be retried deterministically without leaving Python work running.
        for requirement in requirements:
            parsed = Requirement(requirement) if isinstance(requirement, str) else requirement
            if parsed.url:
                raise ValueError("external_url")
            await self.add_requirement(parsed)


def inventory():
    return sorted({
        f"{canonicalize_name(dist.metadata['Name'])}=={dist.version}"
        for dist in importlib.metadata.distributions()
        if dist.metadata.get("Name")
    })


def _validate_installed(requirements):
    """Check the complete installed closure, including requested extras, offline.

    A saved lock is notebook input, not proof that its roots and dependencies
    exist. Micropip's deps=False install alone cannot establish that contract.
    """
    pending = [(Requirement(req), frozenset()) for req in requirements]
    visited = set()
    checked = 0
    while pending:
        req, parent_extras = pending.pop()
        checked += 1
        if checked > 1024 or req.url:
            raise ValueError("unsupported_requirement_closure")
        if req.marker and not any(
            req.marker.evaluate({**default_environment(), "extra": extra})
            for extra in parent_extras | {""}
        ):
            continue
        dist = importlib.metadata.distribution(req.name)
        if not req.specifier.contains(dist.version, prereleases=True):
            raise ValueError("incomplete_package_plan")
        key = (canonicalize_name(req.name), frozenset(req.extras))
        if key in visited:
            continue
        visited.add(key)
        for dependency in dist.requires or []:
            pending.append((Requirement(dependency), frozenset(req.extras)))


async def plan_packages(payload_json):
    payload = json.loads(payload_json)
    if payload.get("artifact"):
        artifact = payload["artifact"]
        _artifacts[artifact["url"]] = artifact
    wheelinfo.fetch_bytes = _fetch_bytes
    transaction = OfflineTransaction(
        _compat_layer=OfflineCompatibility,
        ctx=default_environment(),
        ctx_extras=[],
        keep_going=False,
        deps=True,
        pre=False,
        fetch_kwargs={},
        index_urls=["https://pypi.org/pypi/{package_name}/json"],
        constraints=payload.get("constraints", []),
    )
    try:
        await transaction.gather_requirements(payload["requirements"])
        return json.dumps({
            "status": "ready",
            "wheels": [
                {"name": wheel.name, "version": str(wheel.version), "url": wheel.url,
                 "dependencies": sorted({canonicalize_name(req.name) for req in wheel._requires or []})}
                for wheel in transaction.wheels
            ],
            "requirements": [str(Requirement(req)) for req in payload["requirements"]],
        })
    except MissingArtifact as missing:
        return json.dumps({"status": "fetch", "url": str(missing)})
    except Exception as error:
        # Error text can contain arbitrary package metadata; never send it to
        # provider logs or the notebook. The UI supplies bounded recovery copy.
        message = str(error)
        code = "incompatible" if "already installed" in message else "unavailable"
        return json.dumps({"status": "error", "code": code})


async def install_packages(payload_json):
    payload = json.loads(payload_json)
    directory = Path("/tmp/nteract-wheels")
    directory.mkdir(exist_ok=True)
    paths = []
    try:
        for wheel in payload["wheels"]:
            data = base64.b64decode(wheel["body"])
            if hashlib.sha256(data).hexdigest() != wheel["sha256"]:
                raise ValueError("wheel_integrity")
            _validate_wheel(data)
            path = directory / wheel["filename"]
            if path.parent != directory:
                raise ValueError("wheel_path")
            path.write_bytes(data)
            paths.append(path)
        # Resolution was completed in the clean planner. No network, extra
        # indexes, source builds, or implicit transitive fetches in this session.
        await micropip.install([f"emfs:{path}" for path in paths], deps=False)
        _validate_installed(payload["requirements"])
        return json.dumps({"status": "ready", "installed": inventory()})
    except Exception:
        # Micropip may already have unpacked some wheels. Do not claim rollback.
        return json.dumps({"status": "error", "code": "install_failed", "needs_restart": True})
    finally:
        for path in paths:
            path.unlink(missing_ok=True)
