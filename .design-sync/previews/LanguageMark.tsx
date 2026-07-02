import { LanguageMark } from "nteract-elements";

function Chip({ language }: { language: string }) {
  return (
    <span
      className="text-xs text-muted-foreground"
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <LanguageMark language={language} size={14} />
      {language}
    </span>
  );
}

// Python gets the real two-tone mark; everything else the identity dot.
// Today's lineup is Python and Deno/TypeScript - SQL and R dots are ready for
// when those runtimes land.
export function Marks() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <Chip language="Python" />
      <Chip language="Deno" />
      <Chip language="TypeScript" />
      <Chip language="SQL" />
      <Chip language="R" />
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", alignItems: "end", gap: 14 }}>
      <LanguageMark language="Python" size={12} />
      <LanguageMark language="Python" size={16} />
      <LanguageMark language="Python" size={24} />
      <LanguageMark language="Python" size={32} />
    </div>
  );
}
