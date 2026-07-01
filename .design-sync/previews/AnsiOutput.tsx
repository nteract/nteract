import { AnsiOutput } from "nteract-elements";

// ESC built from a char code so the source stays pure ASCII (a raw 0x1b byte in
// a source file breaks diffs and editors). `E` is the CSI intro: ESC + "[".
const E = String.fromCharCode(27) + "[";

// A pytest run: bold session header, green dots / red F for pass/fail, a yellow
// percent gutter, and a bold red summary line.
const pytest = [
  `${E}1m============================= test session starts =============================${E}0m`,
  "platform darwin -- Python 3.12.2, pytest-8.1.1, pluggy-1.4.0",
  "collected 24 items",
  "",
  `tests/test_frame.py ${E}32m.${E}0m${E}32m.${E}0m${E}32m.${E}0m${E}31mF${E}0m${E}32m.${E}0m${E}32m.${E}0m          ${E}33m[ 60%]${E}0m`,
  `tests/test_io.py ${E}32m.${E}0m${E}32m.${E}0m${E}32m.${E}0m                                     ${E}33m[100%]${E}0m`,
  "",
  `${E}31m${E}1m========================== 1 failed, 23 passed in 2.14s ==========================${E}0m`,
].join("\n");

export function PytestRun() {
  return <AnsiOutput>{pytest}</AnsiOutput>;
}

// Shows the renderer's color fidelity: the standard 16 colors, normal and bold,
// which the component maps to theme-aware CSS variables (adapts to light/dark).
const palette = [30, 31, 32, 33, 34, 35, 36, 37]
  .map((c) => `${E}${c}m████${E}0m ${E}1;${c}m████${E}0m`)
  .join("   ");

export function ColorPalette() {
  return <AnsiOutput>{`Standard 16-color palette — normal and bold\n\n${palette}`}</AnsiOutput>;
}
