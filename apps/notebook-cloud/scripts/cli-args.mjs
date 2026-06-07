export function firstPositionalArg(args = process.argv.slice(2)) {
  for (const arg of args) {
    if (arg === "--" || arg.trim() === "") {
      continue;
    }
    return arg;
  }
  return undefined;
}
