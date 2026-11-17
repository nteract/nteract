import { useMemo } from "react";
import { codeTokens } from "./code-highlight.mjs";
import "./code-highlight.css";

/** Read-only code using the document editor's tokenizer and theme. React
 * renders every segment as text, including unknown languages and the tail
 * beyond the highlighting budget. */
export function CodeHighlight({ text, language }) {
  const content = useMemo(() => {
    const parts = [];
    let offset = 0;
    codeTokens(text, language, (kind, from, to) => {
      if (from > offset) parts.push(text.slice(offset, from));
      parts.push(
        <span key={from} className={`wg-t-${kind}`}>
          {text.slice(from, to)}
        </span>,
      );
      offset = to;
    });
    parts.push(text.slice(offset));
    return parts;
  }, [text, language]);
  return <code className="pages-code-highlight">{content}</code>;
}
