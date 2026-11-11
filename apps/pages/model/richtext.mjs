// The rich-text codec's public names in one place. Each job lives in its own
// module; import from that module when only one job is needed:
//
// - richtext-format.mjs: the block format and span helpers that need no codec.
// - markdown-tokenizer.mjs: markdown-it with the Pages rules.
// - markdown-scan.mjs: math and HTML detection, refusal and literal escaping.
// - markdown-import.mjs: Markdown to a native tree.
// - markdown-native.mjs: block tokens to Wordgard nodes.
// - markdown-serializer.mjs: Markdown from a Wordgard tree.
// - richtext-spans.mjs: projection reads, canonical Page spans, validation.
// - richtext-page.mjs: Page block writers and Markdown projection.
// - richtext-notices.mjs: notices and labels for nodes Markdown can't hold.
export { safeUrl, textPath, codeTextUnmarked } from "./richtext-format.mjs";
export { richSize, isBlankBlock } from "./richtext-format.mjs";
export { schema } from "./wordgard-doc.mjs";
export { unknownNodeNotice, quotableNodeType, dataframeLabel } from "./richtext-notices.mjs";
export { MATH_SYNTAX, unsupportedMarkdown, unsupportedMarkdownError } from "./markdown-scan.mjs";
export {
  parseMarkdown,
  nativeImportLoss,
  lostContent,
  parseAgentMarkdown,
  parseInlineMarkdown,
} from "./markdown-import.mjs";
export { exportMarkdown } from "./markdown-serializer.mjs";
export {
  richDoc,
  pageSpans,
  markdownlessNode,
  validateRich,
  validateRichSpans,
} from "./richtext-spans.mjs";
export {
  blockMarkdown,
  setRichMarkdown,
  setRichImage,
  setRichNode,
  setRichMarkdownKeepingNodes,
  projectedBlock,
} from "./richtext-page.mjs";
