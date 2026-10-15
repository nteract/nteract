"""Native bridge contracts, each in a fresh interpreter (no daemon required).

Run only against a built binding, e.g. in PR image/wheel CI. The parent process
never imports runtimed; the timeout makes a shutdown deadlock a test failure.
"""

from __future__ import annotations

import asyncio
import atexit
import contextvars
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


def delivery_contract() -> None:
    import runtimed._internals as native

    async def main() -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = native.NativeAsyncClient(socket_path=str(Path(temporary) / "missing"))
            # Native close returns Rust (), which IntoPyObject maps to a tuple.
            assert await client.close() == ()
            try:
                await client.status()
            except native.RuntimedError:
                pass
            else:
                raise AssertionError("native error was not delivered")

            cancelled = client.close()
            assert cancelled.cancel()
            try:
                await cancelled
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("cancelled Future resumed successfully")

            variable = contextvars.ContextVar("bridge-context")

            async def isolated(value: str) -> None:
                variable.set(value)
                future = client.close()
                observed = asyncio.get_running_loop().create_future()
                future.add_done_callback(lambda _: observed.set_result(variable.get()))
                await future
                assert variable.get() == value
                assert await observed == value

            await asyncio.gather(isolated("first"), isolated("second"))

            loop = asyncio.get_running_loop()
            write = loop._write_to_self
            entered = threading.Event()
            release = threading.Event()

            def blocked_write() -> None:
                entered.set()
                assert release.wait(10), "cancelled delivery was not released"
                write()

            loop._write_to_self = blocked_write
            try:
                future = client.close()
                assert entered.wait(10), "delivery did not reach loop wakeup"
                assert future.cancel()
                release.set()
                try:
                    await future
                except asyncio.CancelledError:
                    pass
                else:
                    raise AssertionError("cancellation during delivery was lost")
            finally:
                release.set()
                loop._write_to_self = write

            reentrant_errors = []

            def reentrant_write() -> None:
                try:
                    native._drain_async_deliveries()
                except RuntimeError as error:
                    reentrant_errors.append(str(error))
                write()

            loop._write_to_self = reentrant_write
            try:
                await client.close()
                assert reentrant_errors == [
                    "cannot drain runtimed async deliveries from a delivery callback"
                ]
            finally:
                loop._write_to_self = write

    asyncio.run(main())
    print("delivery contract ok", flush=True)


def blocked_wakeup(*, automatic: bool) -> None:
    entered = threading.Event()
    release = threading.Event()
    captured_dropped = threading.Event()
    gate_closed = threading.Event()
    drain_returned = threading.Event()
    errors = []

    def verify() -> None:
        assert gate_closed.is_set(), "new conversions were not rejected"
        assert captured_dropped.is_set(), "drain returned before context destruction"
        assert not errors, errors
        print("drain contract ok", flush=True)

    # Registered BEFORE native import: this runs after its retained atexit hook.
    # The parent requires the marker; an ignored atexit assertion cannot pass.
    if automatic:
        atexit.register(verify)

    import runtimed._internals as native

    client = native.NativeAsyncClient()
    loop = asyncio.new_event_loop()
    write = loop._write_to_self
    variable = contextvars.ContextVar("captured-until-delivery-returns")

    class Capture:
        def __del__(self) -> None:
            if drain_returned.is_set():
                errors.append("capture outlived drain")
            captured_dropped.set()

    def blocked_write() -> None:
        # Wake the loop FIRST. Its Future can finish while this worker still
        # owns TaskLocals, reproducing the ordering in the captured native stack.
        write()
        entered.set()
        if not release.wait(10):
            errors.append("delivery release timed out")

    loop._write_to_self = blocked_write

    async def main() -> None:
        token = variable.set(Capture())
        try:
            await client.close()
        finally:
            variable.reset(token)
        assert entered.wait(10), "delivery never entered the blocked wakeup"

    loop.run_until_complete(main())
    loop.close()
    assert not captured_dropped.is_set(), "test did not retain the delivery context"

    def release_after_gate_closes() -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                client.close()
            except RuntimeError as error:
                if "async result delivery is shutting down" in str(error):
                    gate_closed.set()
                    break
                # Before closing, this thread has no running event loop.
                if "no running event loop" not in str(error):
                    errors.append(str(error))
                    break
            else:
                errors.append("close returned a Future without a running loop")
                break
            gate_closed.wait(0.001)
        if not gate_closed.is_set():
            errors.append("shutdown never closed admission")
        if drain_returned.is_set():
            errors.append("drain returned while the callback was blocked")
        release.set()

    threading.Thread(target=release_after_gate_closes, daemon=True).start()
    if automatic:
        print("ordinary interpreter exit follows", flush=True)
        return
    native._drain_async_deliveries()
    drain_returned.set()
    native._drain_async_deliveries()  # Idempotent; no reopened admission.
    verify()


class AsyncBridgeTests(unittest.TestCase):
    def run_case(self, case: str, marker: str) -> None:
        result = subprocess.run(
            [sys.executable, "-I", "-X", "faulthandler", "-u", __file__, "--case", case],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(marker, result.stdout, result.stdout + result.stderr)

    def test_success_error_cancellation_and_context(self) -> None:
        self.run_case("delivery", "delivery contract ok")

    def test_drain_waits_beyond_future_readiness(self) -> None:
        self.run_case("blocked", "drain contract ok")

    def test_ordinary_interpreter_exit_drains_automatically(self) -> None:
        self.run_case("exit", "drain contract ok")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--case":
        if sys.argv[2] == "delivery":
            delivery_contract()
        else:
            blocked_wakeup(automatic=sys.argv[2] == "exit")
    else:
        unittest.main()
