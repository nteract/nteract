"""Notebook evaluation without Jupyter transport; one module per isolated session."""

import ast
import contextlib
import inspect
import io
import json
import traceback

namespace = {"__name__": "__main__"}
execution_count = 0


async def evaluate(source, execution_id):
    global execution_count
    execution_count += 1
    outputs = []

    class Stream(io.TextIOBase):
        def __init__(self, name):
            self.name = name

        def write(self, text):
            if text:
                if outputs and outputs[-1].get("name") == self.name:
                    outputs[-1]["text"] += text
                else:
                    outputs.append({"output_type": "stream", "name": self.name, "text": text})
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
                    outputs.append({"output_type": "execute_result", "execution_count": execution_count,
                                    "data": {"text/plain": repr(result)}, "metadata": {}})
        except BaseException as error:
            success = False
            outputs.append({"output_type": "error", "ename": type(error).__name__,
                            "evalue": str(error), "traceback": traceback.format_exception(error)})
    return json.dumps({"execution_id": execution_id, "execution_count": execution_count,
                       "success": success, "outputs": outputs})
