"""IPython notebook semantics inside one jailed, session-owned interpreter."""

import contextlib
import hashlib
import io
import json
import sys
import traceback
from contextvars import ContextVar

import matplotlib
from IPython.core.compilerop import CachingCompiler
from IPython.core.displayhook import DisplayHook
from IPython.core.displaypub import DisplayPublisher
from IPython.core.interactiveshell import InteractiveShell
from matplotlib_inline.backend_inline import configure_inline_support
from nteract_kernel_launcher import _traceback
from traitlets.config import Config

active_outputs = None
active_execution = None
output_bytes = 0
output_context = ContextVar("nteract_execution_output", default=None)
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_OUTPUTS = 1000

# Live deltas are flushed by writes; naturally yielding async cells let the host
# transport publish them before completion. No guest clock or sleep override.
MAX_LIVE_STREAM_BYTES = 256 * 1024
live_sink = None
live_pending = None
live_sent_bytes = 0


def send_live(event):
    if live_sink is not None:
        live_sink(json.dumps(event))


def flush_live_stream(everything=False):
    """Send buffered stream text up to the last newline (or all of it)."""
    global live_pending, live_sent_bytes
    if live_sink is None or live_pending is None:
        return
    name, text = live_pending
    cut = len(text) if everything else text.rfind("\n") + 1
    if cut <= 0:
        return
    chunk, rest = text[:cut], text[cut:]
    live_pending = (name, rest) if rest else None
    if live_sent_bytes + len(chunk) > MAX_LIVE_STREAM_BYTES:
        # Stop live updates; the final batch still carries every output.
        live_pending = None
        stop_live()
        return
    live_sent_bytes += len(chunk)
    send_live({"type": "stream", "name": name, "text": chunk})


def buffer_live(output):
    global live_pending
    if live_sink is None:
        return
    if output["output_type"] != "stream":
        flush_live_stream(everything=True)
        if output["output_type"] == "clear_output":
            send_live({"type": "clear", "wait": bool(output.get("wait"))})
        else:
            send_live({"type": "boundary"})
        return
    if live_pending is not None and live_pending[0] != output["name"]:
        flush_live_stream(everything=True)
    name = output["name"]
    previous = live_pending[1] if live_pending is not None else ""
    live_pending = (name, previous + output["text"])


def stop_live():
    global live_sink
    if live_sink is not None:
        send_live({"type": "live_stopped"})
    live_sink = None


def emit(output):
    global output_bytes
    context = output_context.get()
    if context is None or context["closed"]:
        return
    previous = active_outputs[-1] if active_outputs else None
    if (
        output["output_type"] == "stream"
        and previous is not None
        and previous["output_type"] == "stream"
        and previous["name"] == output["name"]
    ):
        # Coalesce consecutive writes to one stream, as Jupyter frontends do.
        # print() alone issues separate writes for each argument, separator and
        # newline; one record per write would exhaust MAX_OUTPUTS quickly.
        size = len(json.dumps(output["text"]).encode("utf-8")) - 2
        if output_bytes + size > MAX_OUTPUT_BYTES:
            raise RuntimeError("Python output limit exceeded")
        output_bytes += size
        previous["text"] += output["text"]
        buffer_live(output)
        flush_live_stream()
        return
    size = len(json.dumps(output).encode("utf-8"))
    if output_bytes + size > MAX_OUTPUT_BYTES or len(active_outputs) >= MAX_OUTPUTS:
        raise RuntimeError("Python output limit exceeded")
    output_bytes += size
    active_outputs.append(output)
    buffer_live(output)
    flush_live_stream()


class NotebookPublisher(DisplayPublisher):
    def publish(self, data, metadata=None, source=None, *, transient=None, update=False, **kwargs):
        emit(
            {
                "output_type": "update_display_data" if update else "display_data",
                "data": data,
                "metadata": metadata or {},
                "transient": transient or {},
            }
        )

    def clear_output(self, wait=False):
        emit({"output_type": "clear_output", "wait": bool(wait)})


class NotebookDisplayHook(DisplayHook):
    """Retain IPython history/semicolon semantics, replace only the output sink."""

    def write_output_prompt(self):
        pass

    def write_format_data(self, format_dict, md_dict=None):
        if format_dict:
            emit(
                {
                    "output_type": "execute_result",
                    "execution_count": output_context.get()["execution"]["execution_count"],
                    "data": format_dict,
                    "metadata": md_dict or {},
                }
            )

    def finish_displayhook(self):
        self.is_active = False


class NotebookCompiler(CachingCompiler):
    def get_code_name(self, raw_code, transformed_code, number):
        context = output_context.get()
        if context is None or context["closed"]:
            return super().get_code_name(raw_code, transformed_code, number)
        execution = context["execution"]
        filename = f"<notebook:{execution['execution_id']}>"
        _traceback.register_cell_source(
            shell,
            raw_code,
            execution_id=execution["execution_id"],
            cell_id=execution["cell_id"],
            execution_count=execution["execution_count"],
            compiled_filename=filename,
        )
        return filename


class NotebookShell(InteractiveShell):
    def get_parent(self):
        context = output_context.get()
        return {"metadata": {"nteract": context["execution"] if context else {}}}

    def _showtraceback(self, etype, evalue, stb):
        global output_bytes
        # Reserve one diagnostic beyond the regular output budget, so exhausting
        # stdout cannot prevent the actual exception from reaching the notebook.
        context = output_context.get()
        if context is None or context["closed"]:
            return
        try:
            payload = _traceback.build_rich_payload(etype, evalue, evalue.__traceback__, self)
            output = {
                "output_type": "display_data",
                "data": {_traceback.TRACEBACK_MIME: payload},
                "metadata": {},
            }
            if len(json.dumps(output).encode("utf-8")) > 32768:
                raise ValueError("Traceback exceeds diagnostic budget")
        except BaseException:
            try:
                message = str(evalue)[:4096]
            except BaseException:
                message = "Exception message unavailable: formatting failed"
            try:
                formatted = "".join(traceback.format_exception(evalue))[-16384:]
            except BaseException:
                formatted = "Traceback unavailable: formatting failed"
            output = {
                "output_type": "error",
                "ename": etype.__name__[:256],
                "evalue": message,
                "traceback": [formatted],
            }
            # JSON escapes can expand non-ASCII text beyond the character cap.
            if len(json.dumps(output).encode("utf-8")) > 32768:
                output["evalue"] = message[:1024]
                output["traceback"] = ["Traceback exceeded diagnostic budget"]
        size = len(json.dumps(output).encode("utf-8"))
        if output_bytes + size <= MAX_OUTPUT_BYTES and len(active_outputs) < MAX_OUTPUTS:
            output_bytes += size
            active_outputs.append(output)
        elif not context.get("diagnostic_reserved", False):
            context["diagnostic_reserved"] = True
            active_outputs.append(output)

    def showsyntaxerror(self, filename=None, running_compiled_code=False):
        etype, evalue, _ = sys.exc_info()
        self._showtraceback(etype, evalue, [])

    def system(self, command):
        raise RuntimeError("Shell commands are unavailable in sandboxed Python")

    def getoutput(self, command, split=True, depth=0):
        raise RuntimeError("Shell commands are unavailable in sandboxed Python")


config = Config()
# Keep In/Out in memory, without starting a SQLite history thread in Wasm.
config.HistoryManager.enabled = False
shell = NotebookShell.instance(
    user_ns={"__name__": "__main__"},
    config=config,
    displayhook_class=NotebookDisplayHook,
    display_pub_class=NotebookPublisher,
    compiler_class=NotebookCompiler,
)
matplotlib.use("module://matplotlib_inline.backend_inline")
matplotlib.interactive(True)
configure_inline_support(shell, "inline")


class Stream(io.TextIOBase):
    def __init__(self, name):
        self.name = name

    def write(self, text):
        if text:
            emit({"output_type": "stream", "name": self.name, "text": text})
        return len(text)

    def flush(self):
        pass


async def evaluate(source, execution_id, cell_id, sink=None):
    global active_outputs, active_execution, output_bytes
    global live_sink, live_pending, live_sent_bytes
    if active_execution is not None:
        raise RuntimeError("Python session is already executing")
    execution = {
        "execution_id": execution_id,
        "cell_id": cell_id,
        "source_hash": "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "execution_count": shell.execution_count,
    }
    outputs = []
    active_outputs = outputs
    active_execution = execution
    context = {"execution": execution, "closed": False}
    token = output_context.set(context)
    output_bytes = 0
    live_sink = sink
    live_pending = None
    live_sent_bytes = 0
    result = None
    success = False
    try:
        with (
            contextlib.redirect_stdout(Stream("stdout")),
            contextlib.redirect_stderr(Stream("stderr")),
        ):
            try:
                preprocessing_error = None
                try:
                    transformed = shell.transform_cell(source)
                except Exception:
                    transformed = source
                    preprocessing_error = sys.exc_info()
                result = await shell.run_cell_async(
                    source,
                    store_history=True,
                    cell_id=cell_id,
                    transformed_cell=transformed,
                    preprocessing_exc_tuple=preprocessing_error,
                )
                success = result.success
            except BaseException:
                etype, error, _ = sys.exc_info()
                shell._showtraceback(etype, error, [])
            finally:
                # run_cell_async owns pre_* events; its caller owns post_*.
                # Keep output capture alive for Matplotlib and extension hooks.
                shell.events.trigger("post_execute")
                shell.events.trigger("post_run_cell", result)
    finally:
        flush_live_stream(everything=True)
        context["closed"] = True
        output_context.reset(token)
        active_outputs = None
        active_execution = None
        live_sink = None
        live_pending = None
    return json.dumps({**execution, "success": success, "outputs": outputs})
