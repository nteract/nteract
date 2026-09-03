import { cn } from "@/lib/utils";
import logoDarkUrl from "../../../logo-dark.svg";
import logoLightUrl from "../../../logo.svg";

export interface NotebookBrandMarkProps {
  className?: string;
}

export function NotebookBrandMark({ className }: NotebookBrandMarkProps) {
  return (
    <span
      role="img"
      aria-label="nteract"
      className={cn("block size-6 shrink-0 select-none", className)}
      data-testid="notebook-brand-mark"
    >
      <img
        src={logoLightUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="block size-full dark:hidden"
      />
      <img
        src={logoDarkUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="hidden size-full dark:block"
      />
    </span>
  );
}
