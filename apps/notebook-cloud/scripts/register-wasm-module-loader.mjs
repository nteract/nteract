import { register } from "node:module";

register(new URL("./wasm-module-loader-hooks.mjs", import.meta.url));
