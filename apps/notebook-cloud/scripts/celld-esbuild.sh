#!/bin/sh

set -eu

exec esbuild "$@" --loader:.wasm=binary
