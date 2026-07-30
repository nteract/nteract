import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ColorTheme } from "@/bindings";
import type { ThemeMode } from "@/hooks/useTheme";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { NotebookActorAvatar } from "./NotebookIdentity";
import type { NotebookActorIdentity } from "./capabilities";

export interface NotebookSettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  colorTheme?: ColorTheme;
  onColorThemeChange?: (colorTheme: ColorTheme) => void;
  actor?: NotebookActorIdentity | null;
  accountDetail?: string | null;
  accountActions?: ReactNode;
  className?: string;
}

const themeOptions: Array<{ value: ThemeMode; label: string; icon: LucideIcon }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const colorThemeOptions: Array<{ value: ColorTheme; label: string }> = [
  { value: "classic", label: "Classic" },
  { value: "cream", label: "Cream" },
];

export function NotebookSettingsDrawer({
  open,
  onOpenChange,
  theme,
  onThemeChange,
  colorTheme,
  onColorThemeChange,
  actor,
  accountDetail,
  accountActions,
  className,
}: NotebookSettingsDrawerProps) {
  const showPalette = Boolean(colorTheme && onColorThemeChange);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn("w-full gap-0 sm:max-w-md", className)}
        data-slot="notebook-settings-drawer"
      >
        <SheetHeader className="border-b">
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>
            Preferences for this browser. Notebook content is unaffected.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
          <NotebookSettingsSection
            title="Appearance"
            description="Applies to every notebook you open in this browser."
          >
            <div
              role="radiogroup"
              aria-label="Theme"
              className="grid grid-cols-3 gap-2"
              data-slot="notebook-settings-theme"
            >
              {themeOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <NotebookSettingsOption
                    key={option.value}
                    label={option.label}
                    selected={theme === option.value}
                    onSelect={() => onThemeChange(option.value)}
                    data-slot="notebook-settings-theme-option"
                    data-theme-value={option.value}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                  </NotebookSettingsOption>
                );
              })}
            </div>

            {showPalette ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Theme</span>
                <div
                  role="radiogroup"
                  aria-label="Theme"
                  className="grid grid-cols-2 gap-2"
                  data-slot="notebook-settings-theme"
                >
                  {colorThemeOptions.map((option) => (
                    <NotebookSettingsOption
                      key={option.value}
                      label={option.label}
                      selected={colorTheme === option.value}
                      onSelect={() => onColorThemeChange?.(option.value)}
                      data-slot="notebook-settings-palette-option"
                      data-color-theme-value={option.value}
                    >
                      <span
                        aria-hidden="true"
                        data-color-theme={option.value === "classic" ? undefined : option.value}
                        className="size-4 rounded-full border border-border bg-background"
                      />
                    </NotebookSettingsOption>
                  ))}
                </div>
              </div>
            ) : null}
          </NotebookSettingsSection>

          {actor ? (
            <NotebookSettingsSection title="Account">
              <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden="true">
                  <NotebookActorAvatar actor={actor} className="border-0" showStatus={false} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {actor.label}
                  </span>
                  {accountDetail ? (
                    <span className="truncate text-xs text-muted-foreground">{accountDetail}</span>
                  ) : null}
                </span>
              </div>
              {accountActions ? <div className="flex flex-col">{accountActions}</div> : null}
            </NotebookSettingsSection>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function NotebookSettingsOption({
  label,
  selected,
  onSelect,
  children,
  ...props
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-md border px-3 py-3 text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "border-primary/40 bg-muted font-medium text-foreground"
          : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
      {...props}
    >
      {children}
      {label}
    </button>
  );
}

function NotebookSettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" data-slot="notebook-settings-section">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
