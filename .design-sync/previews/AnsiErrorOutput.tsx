import { AnsiErrorOutput } from "nteract-elements";

// ESC built from a char code so the source stays pure ASCII (a raw 0x1b byte in
// a source file breaks diffs and editors). `E` is the CSI intro: ESC + "[".
const E = String.fromCharCode(27) + "[";

// A classic IPython-formatted traceback: the ANSI the kernel actually emits,
// red rule + type, green cell/line markers, dim source, the arrow on the
// failing line. AnsiErrorOutput renders the raw kernel string verbatim.
const traceback = [
  `${E}0;31m---------------------------------------------------------------------------${E}0m`,
  `${E}0;31mKeyError${E}0m                                  Traceback (most recent call last)`,
  `Cell ${E}0;32mIn[7], line 3${E}0m`,
  `${E}1;32m      1 ${E}0mdf ${E}0;34m=${E}0m pd${E}0;34m.${E}0mread_csv(${E}0;36m"sales.csv"${E}0m)`,
  `${E}1;32m      2 ${E}0mtotals ${E}0;34m=${E}0m {}`,
  `${E}0;32m----> 3 ${E}0mtotals[${E}0;36m"revenue"${E}0m] ${E}0;34m=${E}0m df[${E}0;36m"region"${E}0m]${E}0;34m.${E}0msum()`,
  "",
  `${E}0;31mKeyError${E}0m: ${E}0;36m'region'${E}0m`,
];

export function KernelTraceback() {
  return <AnsiErrorOutput ename="KeyError" evalue="'region'" traceback={traceback} />;
}

// Headline-only: no traceback array, just the error name and value. The
// component falls back to the one-line `ename: evalue` headline.
export function HeadlineOnly() {
  return <AnsiErrorOutput ename="ValueError" evalue="could not convert string to float: 'N/A'" />;
}
