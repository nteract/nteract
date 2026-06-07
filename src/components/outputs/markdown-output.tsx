import { type ReactNode } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import type { MarkdownHeadingAnchor } from "./markdown-heading-anchors";
import type { Options as RehypeKatexOptions } from "rehype-katex";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import { katexStrict } from "@/lib/katex-options";
import { cn } from "@/lib/utils";
import { MarkdownCodeBlock } from "../markdown/MarkdownCodeBlock";
import { MarkdownFigure, MarkdownFigureCaption, MarkdownImage } from "../markdown/MarkdownFigure";
import { MarkdownHeading } from "../markdown/MarkdownHeading";
import {
  MarkdownTableBody,
  MarkdownTableCell,
  MarkdownTableElement,
  MarkdownTableFrame,
  MarkdownTableHead,
  MarkdownTableHeaderCell,
  MarkdownTableRow,
} from "../markdown/MarkdownTable";
import { MarkdownTaskCheckbox } from "../markdown/MarkdownTask";
import {
  MarkdownBlockquote,
  MarkdownDelete,
  MarkdownEmphasis,
  MarkdownInlineCode,
  MarkdownStrong,
} from "../markdown/MarkdownText";
import {
  markdownDetailsClassName,
  markdownDocumentClassName,
  markdownFootnoteBackrefClassName,
  markdownFootnotesClassName,
  markdownFootnoteRefClassName,
  markdownLinkClassName,
  markdownListMarkerClassName,
  markdownParagraphClassName,
  markdownSummaryClassName,
  markdownSummaryIndicatorClassName,
  markdownTaskListClassName,
  markdownTaskListItemClassName,
  markdownThematicBreakClassName,
} from "../markdown/markdown-typography";

import "katex/dist/katex.min.css";

interface MarkdownOutputProps {
  /**
   * The markdown content to render
   */
  content: string;
  /**
   * Additional CSS classes
   */
  className?: string;
  /**
   * Enable copy button on code blocks
   */
  enableCopyCode?: boolean;
  headingAnchors?: readonly MarkdownHeadingAnchor[];
}

const remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [remarkGfm, remarkMath];
const rehypeKatexOptions = {
  strict: katexStrict,
} satisfies RehypeKatexOptions;
const rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [
  [rehypeKatex, rehypeKatexOptions],
  rehypeRaw,
];

/**
 * Check if the current window is inside an iframe
 */
function isInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function textFromReactNode(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join("");
  if (typeof node === "object" && "props" in node) {
    return textFromReactNode((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * MarkdownOutput component for rendering Markdown content in notebook outputs.
 *
 * Supports:
 * - GitHub Flavored Markdown (tables, strikethrough, task lists, autolinks)
 * - Math/LaTeX via KaTeX
 * - Syntax highlighted code blocks with copy button
 * - Raw HTML in markdown
 *
 * SECURITY: This component MUST be rendered inside a sandboxed iframe.
 * Use OutputArea (with isolated="auto") or IsolatedFrame directly.
 * Throws an error if rendered in the main DOM.
 */
export function MarkdownOutput({
  content,
  className = "",
  enableCopyCode = true,
  headingAnchors = [],
}: MarkdownOutputProps) {
  const isDark = useDarkMode();
  const rawTheme = useColorTheme();
  const colorTheme = rawTheme === "cream" ? "cream" : "classic";
  let headingCursor = 0;

  const takeHeadingAnchor = (level: number, children: ReactNode): MarkdownHeadingAnchor | null => {
    if (headingCursor >= headingAnchors.length) return null;

    const renderedTitle = normalizeHeadingText(textFromReactNode(children));
    const matchingIndex = headingAnchors.findIndex((anchor, index) => {
      return (
        index >= headingCursor &&
        anchor.level === level &&
        normalizeHeadingText(anchor.title) === renderedTitle
      );
    });
    if (matchingIndex >= 0) {
      headingCursor = matchingIndex + 1;
      return headingAnchors[matchingIndex];
    }

    const nextAnchor = headingAnchors[headingCursor];
    if (nextAnchor?.level === level) {
      headingCursor += 1;
      return nextAnchor;
    }

    return null;
  };

  const headingAttributes = (level: number, children: ReactNode) => {
    const anchor = takeHeadingAnchor(level, children);
    if (!anchor) return {};

    return {
      id: anchor.headingAnchorId,
      "data-nteract-heading-anchor": anchor.headingAnchorId,
      "data-nteract-outline-item-id": anchor.itemId,
    };
  };

  const headingAnchorProps = (
    attributes: ReturnType<typeof headingAttributes>,
    children: ReactNode,
  ) => {
    const id = (attributes as { id?: string }).id;
    if (!id) return {};

    return {
      anchorHref: `#${id}`,
      anchorLabel: `Link to ${normalizeHeadingText(textFromReactNode(children))}`,
    };
  };

  if (!content) {
    return null;
  }

  // Require iframe for security - markdown can contain raw HTML
  if (typeof window !== "undefined" && !isInIframe()) {
    throw new Error(
      "MarkdownOutput must be rendered inside an iframe. " +
        "Use OutputArea or IsolatedFrame for markdown content.",
    );
  }

  return (
    <div data-slot="markdown-output" className={cn(markdownDocumentClassName, className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          // Fenced code blocks render their own styled `<pre>` via CodeBlock,
          // so unwrap react-markdown's default `<pre>` to avoid a redundant
          // nested box (and invalid `<pre>` nesting). Only unwrap the wrapper
          // react-markdown generates around a fenced block — a `<pre>` whose
          // sole child is a `<code>` element — so literal `<pre>` HTML keeps
          // its block semantics.
          pre({ node, children }) {
            const childElements = node?.children.filter((child) => child.type === "element") ?? [];
            const wrapsCodeBlock =
              childElements.length === 1 && childElements[0].tagName === "code";
            return wrapsCodeBlock ? <>{children}</> : <pre>{children}</pre>;
          },

          // Code blocks with syntax highlighting
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const language = match ? match[1] : "";
            const codeContent = String(children).replace(/\n$/, "");

            // Block code has newlines or a language class
            const isBlockCode = codeContent.includes("\n") || className;

            if (isBlockCode) {
              return (
                <MarkdownCodeBlock
                  code={codeContent}
                  language={language}
                  enableCopy={enableCopyCode}
                  isDark={isDark}
                  colorTheme={colorTheme}
                  copyErrorMessage="Failed to copy code:"
                />
              );
            }

            // Inline code
            return <MarkdownInlineCode {...props}>{children}</MarkdownInlineCode>;
          },

          // Links open in new tab
          a({ href, children, className, ...props }) {
            const linkProps = props as typeof props & {
              "data-footnote-backref"?: string | boolean;
              "data-footnote-ref"?: string | boolean;
            };
            const classNames = className?.split(/\s+/) ?? [];
            const isFootnoteBackref =
              linkProps["data-footnote-backref"] !== undefined ||
              classNames.includes("data-footnote-backref");
            const isFootnoteRef =
              linkProps["data-footnote-ref"] !== undefined ||
              classNames.includes("data-footnote-ref");
            const isDocumentAnchor = href?.startsWith("#") ?? false;
            return (
              <a
                {...props}
                href={href}
                className={cn(
                  markdownLinkClassName,
                  isFootnoteRef && markdownFootnoteRefClassName,
                  isFootnoteBackref && markdownFootnoteBackrefClassName,
                  className,
                )}
                rel={isDocumentAnchor ? undefined : "noopener noreferrer"}
                target={isDocumentAnchor ? undefined : "_blank"}
              >
                {children}
              </a>
            );
          },

          // Tables
          table({ children, ...props }) {
            return (
              <MarkdownTableFrame>
                <MarkdownTableElement {...props}>{children}</MarkdownTableElement>
              </MarkdownTableFrame>
            );
          },
          thead({ children, ...props }) {
            return <MarkdownTableHead {...props}>{children}</MarkdownTableHead>;
          },
          tbody({ children, ...props }) {
            return (
              <MarkdownTableBody className="divide-y divide-border" {...props}>
                {children}
              </MarkdownTableBody>
            );
          },
          tr({ children, ...props }) {
            return <MarkdownTableRow {...props}>{children}</MarkdownTableRow>;
          },
          th({ children, ...props }) {
            return <MarkdownTableHeaderCell {...props}>{children}</MarkdownTableHeaderCell>;
          },
          td({ children, ...props }) {
            return <MarkdownTableCell {...props}>{children}</MarkdownTableCell>;
          },

          // Headings
          h1({ children, ...props }) {
            const attributes = headingAttributes(1, children);
            return (
              <MarkdownHeading
                element="h1"
                {...props}
                {...attributes}
                {...headingAnchorProps(attributes, children)}
              >
                {children}
              </MarkdownHeading>
            );
          },
          h2({ children, ...props }) {
            const attributes = headingAttributes(2, children);
            return (
              <MarkdownHeading
                element="h2"
                {...props}
                {...attributes}
                {...headingAnchorProps(attributes, children)}
              >
                {children}
              </MarkdownHeading>
            );
          },
          h3({ children, ...props }) {
            const attributes = headingAttributes(3, children);
            return (
              <MarkdownHeading
                element="h3"
                {...props}
                {...attributes}
                {...headingAnchorProps(attributes, children)}
              >
                {children}
              </MarkdownHeading>
            );
          },
          h4({ children, ...props }) {
            const attributes = headingAttributes(4, children);
            return (
              <MarkdownHeading
                element="h4"
                {...props}
                {...attributes}
                {...headingAnchorProps(attributes, children)}
              >
                {children}
              </MarkdownHeading>
            );
          },
          h5({ children, ...props }) {
            const attributes = headingAttributes(5, children);
            return (
              <MarkdownHeading
                element="h5"
                {...props}
                {...attributes}
                {...headingAnchorProps(attributes, children)}
              >
                {children}
              </MarkdownHeading>
            );
          },
          h6({ children, ...props }) {
            const attributes = headingAttributes(6, children);
            return (
              <MarkdownHeading
                element="h6"
                {...props}
                {...attributes}
                {...headingAnchorProps(attributes, children)}
              >
                {children}
              </MarkdownHeading>
            );
          },

          // Paragraphs
          p({ children, ...props }) {
            return (
              <p className={markdownParagraphClassName} {...props}>
                {children}
              </p>
            );
          },

          // Lists
          ul({ children, className, ...props }) {
            const classNames = className?.split(/\s+/) ?? [];
            const isTaskList = classNames.includes("contains-task-list");
            return (
              <ul
                className={cn(
                  isTaskList ? markdownTaskListClassName : "my-3 ml-6 list-disc leading-relaxed",
                  !isTaskList && markdownListMarkerClassName,
                  className,
                )}
                {...props}
              >
                {children}
              </ul>
            );
          },
          ol({ children, className, ...props }) {
            const classNames = className?.split(/\s+/) ?? [];
            const isTaskList = classNames.includes("contains-task-list");
            return (
              <ol
                className={cn(
                  isTaskList ? markdownTaskListClassName : "my-3 ml-6 list-decimal leading-relaxed",
                  !isTaskList && markdownListMarkerClassName,
                  className,
                )}
                {...props}
              >
                {children}
              </ol>
            );
          },
          li({ children, className, ...props }) {
            const classNames = className?.split(/\s+/) ?? [];
            const isTaskItem = classNames.includes("task-list-item");
            return (
              <li
                className={cn(isTaskItem ? markdownTaskListItemClassName : "my-1", className)}
                {...props}
              >
                {children}
              </li>
            );
          },
          input({ type, checked, className, ...props }) {
            if (type !== "checkbox") {
              return <input type={type} className={className} {...props} />;
            }

            const isChecked = Boolean(checked);
            return (
              <MarkdownTaskCheckbox
                checked={isChecked}
                inputClassName={className}
                inputProps={props}
              />
            );
          },

          // Blockquotes
          blockquote({ children, ...props }) {
            return <MarkdownBlockquote {...props}>{children}</MarkdownBlockquote>;
          },

          // Horizontal rule
          hr({ ...props }) {
            return <hr className={markdownThematicBreakClassName} {...props} />;
          },

          // Images
          img({ src, alt, ...props }) {
            if (!src) return null;
            return <MarkdownImage src={src} alt={alt || ""} {...props} />;
          },

          figure({ children, ...props }) {
            return <MarkdownFigure {...props}>{children}</MarkdownFigure>;
          },

          figcaption({ children, ...props }) {
            return <MarkdownFigureCaption {...props}>{children}</MarkdownFigureCaption>;
          },

          strong({ children, ...props }) {
            return <MarkdownStrong {...props}>{children}</MarkdownStrong>;
          },

          em({ children, ...props }) {
            return <MarkdownEmphasis {...props}>{children}</MarkdownEmphasis>;
          },

          del({ children, ...props }) {
            return <MarkdownDelete {...props}>{children}</MarkdownDelete>;
          },

          details({ children, ...props }) {
            return (
              <details className={markdownDetailsClassName} {...props}>
                {children}
              </details>
            );
          },

          summary({ children, ...props }) {
            return (
              <summary className={markdownSummaryClassName} {...props}>
                <span aria-hidden="true" className={markdownSummaryIndicatorClassName}>
                  ›
                </span>
                <span className="min-w-0">{children}</span>
              </summary>
            );
          },

          section({ children, className, ...props }) {
            const sectionProps = props as typeof props & {
              "data-footnotes"?: string | boolean;
            };
            const isFootnotes = sectionProps["data-footnotes"] !== undefined;
            return (
              <section
                className={cn(isFootnotes && markdownFootnotesClassName, className)}
                {...props}
              >
                {children}
              </section>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
