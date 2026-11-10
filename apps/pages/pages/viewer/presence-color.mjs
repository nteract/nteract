// One stable color per participant, from nteract's cursor palette. The key is
// principal plus driver, so two agents on one account get different colors.
import {
  peerColor,
  readableForegroundForColor,
} from "../../../../../../packages/runtimed/src/notebook-actor-color.ts";

// The session label and MCP session tag join the key when present, so two
// sessions of one account and harness get different colors; keys without them
// are unchanged.
export function presenceColor(principal, driver, agent, session) {
  const base = `${principal ?? ""}/${(driver ?? "").toLowerCase()}`;
  const key = [base, agent, session && `#${session}`].filter(Boolean).join("/");
  const background = peerColor(key);
  return { background, foreground: readableForegroundForColor(background) };
}
