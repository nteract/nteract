"""Smoke tests to verify the package can be imported."""

import os


def test_import():
    """Verify the nteract package can be imported."""
    import nteract

    assert hasattr(nteract, "main")


def test_mcp_server_import():
    """Verify the MCP server module can be imported."""
    from nteract._mcp_server import mcp

    assert mcp.name == "nteract"


def test_main_uses_stdio_transport(monkeypatch):
    """Verify the entrypoint starts the MCP server over stdio."""
    from nteract import _mcp_server

    monkeypatch.delenv("RUNTIMED_SOCKET_PATH", raising=False)

    called: dict[str, str] = {}

    def fake_run(*, transport: str):
        called["transport"] = transport

    monkeypatch.setattr(_mcp_server.mcp, "run", fake_run)

    _mcp_server.main([])

    assert called == {"transport": "stdio"}
    assert "RUNTIMED_SOCKET_PATH" not in os.environ


def test_main_nightly_sets_socket_path(monkeypatch):
    """Verify --nightly points runtimed at the nightly daemon socket."""
    from nteract import _mcp_server

    monkeypatch.setenv("RUNTIMED_SOCKET_PATH", "/tmp/custom.sock")

    called: dict[str, str] = {}

    def fake_run(*, transport: str):
        called["transport"] = transport

    monkeypatch.setattr(_mcp_server.mcp, "run", fake_run)

    _mcp_server.main(["--nightly"])

    assert called == {"transport": "stdio"}
    assert os.environ["RUNTIMED_SOCKET_PATH"] == str(_mcp_server._NIGHTLY_SOCKET_PATH)
