// Page tags: the alphabet a tag may use, and the boolean expression a listing
// filters by. Tags live in D1 (`page_tags`), never in a Page's Automerge
// document, and mean nothing to Pages: they grant no access.
//
// `page_tags` is the single normative record of tags. It is not an index of
// anything and has no Durable Object source: there is no tag state in a Page
// host or Catalog, and none is planned, because tags have no real-time part
// and need only request/response access. Do not confuse it with the
// `pages_catalog_*` tables, which project Durable Object state and can be
// rebuilt. This file holds pure functions only; reads and writes of the table
// are in page-tags-store.mjs.
//
// An expression is a boolean over the set of tags a Page has:
//
//   expression = operand
//              | operand "AND" operand { "AND" operand }
//              | operand "OR"  operand { "OR"  operand }
//   operand    = tag | "NOT" operand | "(" expression ")"
//
// AND and OR never mix at one level: `a AND b OR c` is refused so no caller
// relies on a precedence rule it may misremember. Operators are exactly
// uppercase; every other word is a tag, lowercased before it matches.

/** A tag: lowercase letters, digits and `. _ : / -`, starting with a letter
 * or digit, 1 to 64 characters. Every character is legal unescaped in a URL
 * query, and none is a space, a parenthesis or an operator character. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;
/** The most tags one Page holds. */
export const MAX_TAGS_PER_PAGE = 32;
/** Words an expression reads as operators, so no tag may spell them. */
export const RESERVED_TAGS = Object.freeze(["and", "or", "not"]);

/** The longest expression, in characters, as written and as written back
 * canonically (`parseTagExpression`). */
export const MAX_EXPRESSION_LENGTH = 256;
/** The most tags one expression names. */
export const MAX_EXPRESSION_TAGS = 16;
/** The deepest nesting of parentheses and NOT. */
export const MAX_EXPRESSION_DEPTH = 4;

export class TagError extends Error {
  /** `position` is the zero-based character offset of the problem, when the
   * problem is in an expression. */
  constructor(message, position) {
    super(position === undefined ? message : `${message} (at character ${position})`);
    this.position = position;
  }
}

/** A tag as stored and matched: trimmed and lowercased. Throws a TagError for
 * anything outside the alphabet, a reserved word or a non-string. */
export function normalizeTag(value) {
  if (typeof value !== "string") throw new TagError("A tag must be a string");
  const tag = value.trim().toLowerCase();
  if (RESERVED_TAGS.includes(tag))
    throw new TagError(
      `"${tag}" is reserved: AND, OR and NOT are operators, written uppercase, so it can't be a tag`,
    );
  if (!TAG_PATTERN.test(tag))
    throw new TagError(
      `${quoted(value.trim())} isn't a tag: a tag is 1 to 64 characters of a-z, 0-9 and . _ : / -, starting with a letter or digit`,
    );
  return tag;
}
/** `value` as a refusal quotes it: JSON-escaped, so a control character
 * shows as an escape, and cut to a tag's length. */
const quoted = (value) =>
  value.length > 64
    ? `${JSON.stringify(value.slice(0, 64)).slice(0, -1)}…"`
    : JSON.stringify(value);

const OPERATORS = new Set(["AND", "OR", "NOT"]);

/** Split an expression into `{ text, position }` tokens: `(`, `)` and words. */
function tokenize(input) {
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "(" || char === ")") {
      tokens.push({ text: char, position: index });
      index += 1;
    } else {
      const start = index;
      while (index < input.length && !/[\s()]/.test(input[index])) index += 1;
      tokens.push({ text: input.slice(start, index), position: start });
    }
  }
  return tokens;
}

/**
 * Parse `input` into `{ ast, canonical, tags }`.
 *
 * `ast` nodes are `{ type: "tag", tag }`, `{ type: "not", operand }` and
 * `{ type: "and" | "or", operands }` (two or more). `canonical` is the
 * expression written back with normalized case and spacing, so two spellings
 * of one request seal one cursor scope. `tags` lists each distinct tag.
 * Throws a TagError with the offending character position.
 */
export function parseTagExpression(input) {
  if (typeof input !== "string") throw new TagError("tags must be a string");
  if (input.length > MAX_EXPRESSION_LENGTH)
    throw new TagError(`tags is at most ${MAX_EXPRESSION_LENGTH} characters`);
  const tokens = tokenize(input);
  if (!tokens.length) throw new TagError("tags is empty");
  let cursor = 0;
  let references = 0;
  const peek = () => tokens[cursor];
  const end = input.length;
  const at = (token) => token?.position ?? end;
  const isOperator = (token, text) => token?.text === text;

  const operand = (depth) => {
    if (depth > MAX_EXPRESSION_DEPTH)
      throw new TagError(`Expressions nest at most ${MAX_EXPRESSION_DEPTH} levels`, at(peek()));
    const token = tokens[cursor];
    if (!token) throw new TagError("Expected a tag, NOT or ( but the expression ended", end);
    if (isOperator(token, "NOT")) {
      cursor += 1;
      return { type: "not", operand: operand(depth + 1) };
    }
    if (token.text === "(") {
      cursor += 1;
      const inner = expression(depth + 1);
      const close = tokens[cursor];
      if (!isOperator(close, ")")) throw new TagError("Expected ) to close the group", at(close));
      cursor += 1;
      return inner;
    }
    if (token.text === ")") throw new TagError("Unexpected )", token.position);
    if (OPERATORS.has(token.text))
      throw new TagError(`Expected a tag, NOT or ( but found ${token.text}`, token.position);
    let tag;
    try {
      tag = normalizeTag(token.text);
    } catch (error) {
      throw new TagError(error.message, token.position);
    }
    references += 1;
    if (references > MAX_EXPRESSION_TAGS)
      throw new TagError(`tags names at most ${MAX_EXPRESSION_TAGS} tags`, token.position);
    cursor += 1;
    return { type: "tag", tag };
  };

  const expression = (depth) => {
    const first = operand(depth);
    const operands = [first];
    let operator = null;
    for (;;) {
      const token = peek();
      if (!token || token.text === ")") break;
      if (token.text !== "AND" && token.text !== "OR")
        throw new TagError(
          ["AND", "OR"].includes(token.text.toUpperCase())
            ? `Operators are uppercase: write ${token.text.toUpperCase()}, not ${token.text}`
            : `Expected AND, OR or the end but found ${token.text}`,
          token.position,
        );
      if (operator && operator !== token.text)
        throw new TagError(
          "AND and OR can't mix at one level: add parentheses, as in (a AND b) OR c",
          token.position,
        );
      operator = token.text;
      cursor += 1;
      operands.push(operand(depth));
    }
    return operator ? { type: operator.toLowerCase(), operands } : first;
  };

  const ast = expression(0);
  if (cursor < tokens.length) {
    const token = tokens[cursor];
    throw new TagError(
      token.text === ")" ? "Unexpected )" : `Unexpected ${token.text}`,
      token.position,
    );
  }
  // The canonical spelling is what a listing echoes as `tag_filter` and seals
  // into its cursor, and a caller may send it back as `tags`. Parentheses it
  // adds can make it longer than the input, so it meets the same bound: an
  // expression this accepts is one its own echo round-trips through.
  const canonical = writeTagExpression(ast);
  if (canonical.length > MAX_EXPRESSION_LENGTH)
    throw new TagError(
      `tags is at most ${MAX_EXPRESSION_LENGTH} characters once written canonically (${canonical.length}: each NOT of a group and each nested group gets a space or parentheses); shorten it`,
    );
  return { ast, canonical, tags: [...new Set(collectTags(ast))] };
}

function collectTags(node) {
  if (node.type === "tag") return [node.tag];
  if (node.type === "not") return collectTags(node.operand);
  return node.operands.flatMap(collectTags);
}

/** An AST written back as an expression. A group nested in another is always
 * parenthesized; a NOT of a group keeps its parentheses. */
export function writeTagExpression(node, nested = false) {
  if (node.type === "tag") return node.tag;
  if (node.type === "not") return `NOT ${writeTagExpression(node.operand, true)}`;
  const text = node.operands
    .map((operand) => writeTagExpression(operand, true))
    .join(node.type === "and" ? " AND " : " OR ");
  return nested ? `(${text})` : text;
}

/** Whether a Page holding exactly the tags in `tags` (a Set) satisfies `ast`. */
export function matchesTags(ast, tags) {
  switch (ast.type) {
    case "tag":
      return tags.has(ast.tag);
    case "not":
      return !matchesTags(ast.operand, tags);
    case "and":
      return ast.operands.every((operand) => matchesTags(operand, tags));
    default:
      return ast.operands.some((operand) => matchesTags(operand, tags));
  }
}

/**
 * SQL for `ast` over `page_tags`, as `{ sql, params }`. `pageIdColumn`
 * is the outer query's Page ID column, for example `a.page_id`. Each tag is
 * one `EXISTS` on the table's primary key, combined by the expression's own
 * AND, OR and NOT. Tags are bound parameters, never interpolated.
 */
export function tagPredicate(ast, pageIdColumn) {
  const params = [];
  const build = (node) => {
    if (node.type === "tag") {
      params.push(node.tag);
      return `EXISTS (SELECT 1 FROM page_tags t WHERE t.page_id = ${pageIdColumn} AND t.tag = ?)`;
    }
    if (node.type === "not") return `NOT (${build(node.operand)})`;
    return `(${node.operands.map(build).join(node.type === "and" ? " AND " : " OR ")})`;
  };
  return { sql: build(ast), params };
}
