"""Direct notebook evaluation with IPython formatting, without kernel transport."""

import ast
import contextlib
import inspect
import io
import json
import traceback

import matplotlib
from IPython.core.displaypub import DisplayPublisher
from IPython.core.interactiveshell import InteractiveShell
from matplotlib_inline.backend_inline import configure_inline_support

namespace = {"__name__": "__main__"}
execution_count = 0
active_outputs = None
output_bytes = 0
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_OUTPUTS = 1000


def emit(output):
    global output_bytes
    if active_outputs is None:
        return
    size = len(json.dumps(output).encode("utf-8"))
    if output_bytes + size > MAX_OUTPUT_BYTES or len(active_outputs) >= MAX_OUTPUTS:
        raise RuntimeError("Preview Python output limit exceeded")
    output_bytes += size
    active_outputs.append(output)


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


shell = InteractiveShell.instance(user_ns=namespace, history_load_length=0)
shell.history_manager.enabled = False
shell.display_pub = NotebookPublisher(shell=shell)

matplotlib.use("module://matplotlib_inline.backend_inline")
configure_inline_support(shell, "inline")


async def evaluate(source, execution_id):
    global execution_count, active_outputs, output_bytes
    execution_count += 1
    outputs = []
    active_outputs = outputs
    output_bytes = 0

    class Stream(io.TextIOBase):
        def __init__(self, name):
            self.name = name

        def write(self, text):
            if text:
                emit({"output_type": "stream", "name": self.name, "text": text})
            return len(text)

        def flush(self):
            pass

    success = True
    with contextlib.redirect_stdout(Stream("stdout")), contextlib.redirect_stderr(Stream("stderr")):
        try:
            filename = f"<notebook:{execution_id}>"
            tree = ast.parse(source, filename=filename, mode="exec")
            expression = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                expression = ast.Expression(tree.body.pop().value)
            flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
            result = eval(compile(tree, filename, "exec", flags=flags), namespace)
            if inspect.isawaitable(result):
                await result
            if expression is not None:
                result = eval(compile(expression, filename, "eval", flags=flags), namespace)
                if inspect.isawaitable(result):
                    result = await result
                if result is not None:
                    namespace["_"] = result
                    data, metadata = shell.display_formatter.format(result)
                    emit(
                        {
                            "output_type": "execute_result",
                            "execution_count": execution_count,
                            "data": data,
                            "metadata": metadata,
                        }
                    )
        except BaseException as error:
            success = False
            # Reserve a bounded diagnostic even when regular output exhausted its budget.
            outputs.append(
                {
                    "output_type": "error",
                    "ename": type(error).__name__,
                    "evalue": str(error)[:4096],
                    "traceback": ["".join(traceback.format_exception(error))[-16384:]],
                }
            )
        finally:
            active_outputs = None
    return json.dumps(
        {
            "execution_id": execution_id,
            "execution_count": execution_count,
            "success": success,
            "outputs": outputs,
        }
    )
