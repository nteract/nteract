import { AnsiStreamOutput } from "nteract-elements";

// ESC built from a char code so the source stays pure ASCII (a raw 0x1b byte in
// a source file breaks diffs and editors). `E` is the CSI intro: ESC + "[".
const E = String.fromCharCode(27) + "[";

// stdout with ANSI color: a Keras-style training log. Green progress bars,
// bold metric values, reset between spans.
const trainingLog = [
  "Epoch 1/5",
  `1875/1875 ${E}32m━━━━━━━━━━━━━━━━━━━━${E}0m 4s  loss: ${E}1m0.2947${E}0m  accuracy: ${E}1m0.9142${E}0m`,
  "Epoch 2/5",
  `1875/1875 ${E}32m━━━━━━━━━━━━━━━━━━━━${E}0m 3s  loss: ${E}1m0.1288${E}0m  accuracy: ${E}1m0.9613${E}0m`,
  "Epoch 3/5",
  `1875/1875 ${E}32m━━━━━━━━━━━━━━━━━━━━${E}0m 3s  loss: ${E}1m0.0894${E}0m  accuracy: ${E}1m0.9729${E}0m`,
].join("\n");

// stderr: library warnings, yellow labels, indented continuation.
const stderrLog = [
  `${E}33mConvergenceWarning:${E}0m lbfgs failed to converge (status=1):`,
  "STOP: TOTAL NO. of ITERATIONS REACHED LIMIT.",
  "",
  `${E}33mUserWarning:${E}0m X does not have valid feature names, but LogisticRegression was fitted with feature names`,
  "  warnings.warn(msg, category=UserWarning)",
].join("\n");

export function Stdout() {
  return <AnsiStreamOutput streamName="stdout" text={trainingLog} />;
}

export function Stderr() {
  return <AnsiStreamOutput streamName="stderr" text={stderrLog} />;
}
