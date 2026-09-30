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
  language?: string;
  colorTheme: ColorTheme;
  isDark?: boolean;
  enableCopy?: boolean;
  preClassName?: string;
  copyResetMs?: number;
  copyErrorMessage?: string;
}

export function MarkdownCodeBlock({
  code,
  language,
  colorTheme,
  isDark = false,
  enableCopy = true,
  preClassName,
  copyResetMs = 2000,
  copyErrorMessage = "Failed to copy markdown code block:",
}: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const languageLabel = markdownCodeBlockLanguageLabel(language);

  const copyCode = async () => {
    try {
      // Opaque output frames may not have clipboard-write permission. A copy
      // command invoked by the user's click can still copy selected text.
      if (!(window.self !== window.top && copySelectedCode(code))) {
        await navigator.clipboard.writeText(code);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), copyResetMs);
    } catch (error) {
      console.error(copyErrorMessage, error);
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
        {enableCopy && (
          <button
            type="button"
            aria-label={copied ? "Copied code" : "Copy code"}
            className={markdownCodeBlockCopyButtonClassName}
            title={copied ? "Copied" : "Copy code"}
            onClick={copyCode}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        )}
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

function copySelectedCode(code: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  const activeElement = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const textarea = document.createElement("textarea");
  textarea.value = code;
  textarea.tabIndex = -1;
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}

export function markdownCodeBlockLanguageLabel(language: string | undefined): string {
  const trimmed = language?.trim();
  if (!trimmed) return "code";
  return trimmed;
}
