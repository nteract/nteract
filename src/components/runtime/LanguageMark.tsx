export interface LanguageMarkProps {
  language: string;
  size?: number;
  className?: string;
}

/**
 * Renders the current notebook/runtime language mark from present state; it is
 * not a kernel picker, file type history, or capability signal.
 */
export function LanguageMark({ language, size = 16, className }: LanguageMarkProps) {
  if (/^python$/iu.test(language.trim())) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={["nb-lang-logo", className].filter(Boolean).join(" ")}
      >
        <path
          fill="#3776AB"
          d="M12 2C9.5 2 8 3 8 5v2h5v1H6c-2 0-3 1.5-3 4s1 4 3 4h1v-2c0-2 1.5-3.5 3.5-3.5h4c1.7 0 3-1.4 3-3.1V5c0-2-1.7-3-6-3zm-2 1.4c.6 0 1 .5 1 1 0 .6-.4 1-1 1s-1-.4-1-1c0-.5.4-1 1-1z"
        />
        <path
          fill="#FFD43B"
          d="M12 22c2.5 0 4-1 4-3v-2h-5v-1h7c2 0 3-1.5 3-4s-1-4-3-4h-1v2c0 2-1.5 3.5-3.5 3.5h-4c-1.7 0-3 1.4-3 3.1V19c0 2 1.7 3 6 3zm2-1.4c-.6 0-1-.5-1-1 0-.6.4-1 1-1s1 .4 1 1c0 .5-.4 1-1 1z"
        />
      </svg>
    );
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
