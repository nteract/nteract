import { isProjectId } from "./routes.mjs";

const count = (value) => Number.isSafeInteger(value) && value >= 0;
const decimal = (value) => /^(0|[1-9][0-9]*)$/.test(value) && count(Number(value));

/** Grant identities come from host policy. Parsing validates their wire shape,
 * not the caller's authority. Direct generations retain their persisted number. */
export function parseGrantGeneration(value) {
  if (count(value)) return { source: "direct", direct: value };
  if (typeof value !== "string" || value.length > 100) return null;
  const parts = value.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "project" ||
    !isProjectId(parts[1]) ||
    !decimal(parts[2]) ||
    !decimal(parts[3])
  )
    return null;
  return {
    source: "project",
    project: parts[1],
    member: Number(parts[2]),
    direct: Number(parts[3]),
  };
}

export function projectGrantGeneration(project, member, direct) {
  if (!isProjectId(project) || !count(member) || !count(direct))
    throw Error("Invalid Project grant generation");
  return `project:${project}:${member}:${direct}`;
}

/** -1/0/1 orders only counters owned by the same source. Different Projects,
 * direct/inherited transitions and conflicting component advances are unordered. */
export function compareGrantGenerations(left, right) {
  const a = parseGrantGeneration(left),
    b = parseGrantGeneration(right);
  if (!a || !b || a.source !== b.source || a.project !== b.project) return null;
  const signs = [Math.sign(a.direct - b.direct)];
  if (a.source === "project") signs.push(Math.sign(a.member - b.member));
  if (signs.includes(1) && signs.includes(-1)) return null;
  return signs.includes(1) ? 1 : signs.includes(-1) ? -1 : 0;
}

export function replicaGrantGeneration(key) {
  if (typeof key !== "string") return undefined;
  const match = /^(.*):(writer|commenter|reader)$/.exec(key);
  if (!match) return undefined;
  const value = decimal(match[1]) ? Number(match[1]) : match[1];
  return parseGrantGeneration(value) ? value : undefined;
}
