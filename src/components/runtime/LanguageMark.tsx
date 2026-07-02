import { DenoIcon, PythonIcon } from "@/components/environment/icons";

export interface LanguageMarkProps {
  language: string;
  size?: number;
  className?: string;
}

/**
 * Renders the current notebook/runtime language mark from present state; it is
 * not a kernel picker, file type history, or capability signal. Marks come from
 * the shared environment icon set (the same logos the notebook app uses beside
 * uv/conda/pixi); languages without a dedicated mark render the identity dot.
 */
export function LanguageMark({ language, size = 16, className }: LanguageMarkProps) {
  const normalized = language.trim().toLowerCase();
  const markClass = ["nb-lang-logo", className].filter(Boolean).join(" ");
  if (normalized === "python") {
    return <PythonIcon width={size} height={size} aria-hidden="true" className={markClass} />;
  }
  if (normalized === "deno" || normalized === "typescript") {
    return <DenoIcon width={size} height={size} aria-hidden="true" className={markClass} />;
  }

  return (
    <i
      className={["nb-lang-dot", className].filter(Boolean).join(" ")}
      data-lang={language}
      role="img"
      aria-label={`${language} language mark`}
      style={{ height: size, width: size }}
    />
  );
}
