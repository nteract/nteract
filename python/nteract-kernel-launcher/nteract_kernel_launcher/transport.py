"""Reliable transport policy for nteract's Python kernel entry point.

ZeroMQ PUB sockets normally report successful sends after silently dropping a
subscriber whose per-peer send queue reached its high-water mark.  Notebook
output is durable application state, so nteract keeps the finite queue but
asks libzmq to backpressure the IOPub worker instead of discarding messages.
This intentionally makes a slow daemon delay output publication; shell,
control, and interrupt traffic use separate channels. Users who select the
legacy IPython launcher retain upstream's lossy transport behavior.
"""

from __future__ import annotations

from typing import Any

import zmq


class ReliableIOPubMixin:
    """Enable lossless PUB/XPUB behavior before ipykernel binds IOPub."""

    def _bind_socket(self, s: Any, port: int) -> Any:
        socket_type = s.getsockopt(zmq.TYPE)
        if socket_type in (zmq.PUB, zmq.XPUB):
            # ipykernel 6 uses PUB and ipykernel 7 uses XPUB. libzmq's PUB
            # implementation accepts the XPUB_NODROP policy as well.
            no_drop = getattr(zmq, "XPUB_NODROP", None)
            if no_drop is None:
                self.log.warning(
                    "ZeroMQ does not expose XPUB_NODROP; IOPub may lose output under pressure"
                )
            else:
                try:
                    s.setsockopt(no_drop, 1)
                    self.log.debug("Enabled lossless IOPub delivery")
                except zmq.ZMQError as exc:
                    # Keep older user-managed Python environments launchable.
                    # Their libzmq may predate XPUB_NODROP even when pyzmq
                    # exposes the constant.
                    self.log.warning(
                        "Could not enable lossless IOPub delivery; output may be lost under "
                        "pressure: %s",
                        exc,
                    )
        return super()._bind_socket(s, port)
