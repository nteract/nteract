import { memo } from "react";
import { cn } from "@/lib/utils";
import { CodeMirrorEditor } from "./codemirror-editor";
import { minimalExtensions } from "./extensions";
import type { SupportedLanguage } from "./languages";

export interface ReadOnlyCodeMirrorProps {
  value: string;
  language?: SupportedLanguage;
  className?: string;
  lineWrapping?: boolean;
}

export const ReadOnlyCodeMirror = memo(function ReadOnlyCodeMirror({
  value,
  language = "plain",
  className,
  lineWrapping = false,
}: ReadOnlyCodeMirrorProps) {
  return (
    <CodeMirrorEditor
      initialValue={value}
      language={language}
      readOnly
      baseExtensions={minimalExtensions}
      lineWrapping={lineWrapping}
      className={cn("nteract-readonly-codemirror", className)}
    />
  );
});
