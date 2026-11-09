"""Start a kernel launcher module the way ``python -m`` would.

The daemon runs kernels as::

    python /abs/path/to/kernel_entry.py <launcher-module> -f <connection.json>

with the notebook's directory as the working directory. ``python -m
<launcher-module>`` would put that directory first on ``sys.path`` before the
module is located, so a ``nteract_kernel_launcher.py`` (or a package of the same
name, or ``ipykernel_launcher.py``) sitting next to the notebook would be
started instead of the launcher nteract provides.

Running this file by path puts its own directory, which holds nothing else, at
``sys.path[0]`` instead. The launcher module is located (and, for a package,
imported) while the working directory is off ``sys.path``. The working
directory is then restored at ``sys.path[0]`` and the launcher runs as
``__main__``, so notebook code still imports sibling modules exactly as it
does under ``python -m``.

This file is written into a daemon-owned directory and must only import the
standard library.
"""

import importlib.abc
import importlib.util
import os
import runpy
import sys


class _ResolvedSpecFinder(importlib.abc.MetaPathFinder):
    """Return a pre-resolved spec for one module name, once.

    ``runpy`` looks the module up again by name. By then the working directory
    is back on ``sys.path``, so the lookup must not search it.
    """

    def __init__(self, spec):
        self._spec = spec

    def find_spec(self, fullname, path=None, target=None):
        if fullname != self._spec.name:
            return None
        if self in sys.meta_path:
            sys.meta_path.remove(self)
        return self._spec


def main():
    if len(sys.argv) < 2:
        sys.exit(f"usage: {sys.argv[0]} <module> [args...]")
    module_name = sys.argv.pop(1)

    # With safe_path (-P / PYTHONSAFEPATH) Python adds neither this script's
    # directory nor, under -m, the working directory. Keep that behavior.
    safe_path = getattr(sys.flags, "safe_path", False)
    if not safe_path:
        del sys.path[0]

    spec = importlib.util.find_spec(module_name)
    if spec is None:
        sys.exit(f"{sys.executable}: No module named {module_name}")
    if spec.submodule_search_locations is not None:
        # Import the package now so it and its dependencies come from the
        # environment; runpy then finds `<package>.__main__` through the
        # package's own `__path__`.
        importlib.import_module(module_name)
    else:
        sys.meta_path.insert(0, _ResolvedSpecFinder(spec))

    if not safe_path:
        sys.path.insert(0, os.getcwd())

    runpy.run_module(module_name, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
