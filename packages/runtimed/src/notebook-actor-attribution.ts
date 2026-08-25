export function onBehalfOfText(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? ` for ${trimmed}` : "";
}

/**
 * The long form of on-behalf-of attribution, "on behalf of Ada".
 *
 * Comments name their author in full, so an agent's message reads "Claude Code on
 * behalf of Ada": a comment is a claim someone is accountable for, and the terse
 * " for Ada" of `onBehalfOfText` reads like a recipient rather than a principal.
 * Compact surfaces (presence chips, cursor labels, execution buttons) stay on
 * `onBehalfOfText`, where a whole clause would not fit.
 */
export function onBehalfOfPhrase(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `on behalf of ${trimmed}` : "";
}
