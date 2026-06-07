import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { StaticCodeBlock, type ColorTheme } from "@/components/editor/static-highlight";

import {
  markdownCodeBlockCopyButtonClassName,
  markdownCodeBlockLabelClassName,
  markdownCodeBlockPreStyle,
  markdownCodeBlockShellClassName,
  markdownCodeBlockToolbarClassName,
} from "./markdown-typography";

interface MarkdownCodeBlockProps {
  code: string;
  colorTheme?: ColorTheme;
  enableCopy?: boolean;
  isDark?: boolean;
  language?: string;
  preClassName?: string;
}

export function MarkdownCodeBlock({
  code,
  colorTheme = "classic",
  enableCopy = true,
  isDark = false,
  language,
  preClassName,
}: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const languageLabel = markdownCodeBlockLanguageLabel(language);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      console.error("Failed to copy markdown code block:", error);
    }
  };

  return (
    <div
      data-slot="markdown-code-block"
      className={markdownCodeBlockShellClassName}
      data-code-language={languageLabel === "code" ? undefined : languageLabel}
    >
      <div className={markdownCodeBlockToolbarClassName}>
        <span
          className={markdownCodeBlockLabelClassName}
          title={languageLabel === "code" ? "Code block" : `${languageLabel} code block`}
        >
          {languageLabel}
        </span>
        {enableCopy ? (
          <button
            type="button"
            aria-label={copied ? "Copied code" : "Copy code"}
            className={markdownCodeBlockCopyButtonClassName}
            title={copied ? "Copied" : "Copy code"}
            onClick={copyCode}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        ) : null}
      </div>
      <StaticCodeBlock
        code={code}
        colorTheme={colorTheme}
        isDark={isDark}
        language={language}
        className={preClassName}
        style={markdownCodeBlockPreStyle}
      />
    </div>
  );
}

export function markdownCodeBlockLanguageLabel(language: string | undefined): string {
  const trimmed = language?.trim();
  if (!trimmed) return "code";
  return trimmed;
}
