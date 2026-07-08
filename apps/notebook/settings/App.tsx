import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Monitor,
  Moon,
  Sun,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_FONT_FAMILIES,
  fontFamilyNameToCssValue,
  singleFontFamilyFromCssValue,
  uniqueSortedFontFamilies,
  useNotebookHost,
} from "@nteract/notebook-host";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useNotebookEditorSettings } from "@/components/editor/editor-settings-store";
import {
  FEATURE_FLAGS,
  isKnownPythonEnv,
  isKnownRuntime,
  type ThemeMode,
  useSyncedSettings,
  useSyncedTheme,
} from "@/hooks/useSyncedSettings";
import { cn } from "@/lib/utils";
import { CondaIcon, DenoIcon, PixiIcon, PythonIcon, UvIcon } from "@/components/environment";
import { PrivacySection } from "./sections/Privacy";

/** Format seconds into human-readable duration */
function formatDuration(secs: number): string {
  if (secs >= 86400) {
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (secs >= 3600) {
    const hours = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  if (secs >= 60) {
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return remainingSecs > 0 ? `${mins}m ${remainingSecs}s` : `${mins}m`;
  }
  return `${secs}s`;
}

function useAvailableFontFamilies() {
  const host = useNotebookHost();
  const [fontFamilies, setFontFamilies] = useState(() =>
    uniqueSortedFontFamilies(DEFAULT_FONT_FAMILIES),
  );

  useEffect(() => {
    let cancelled = false;
    host.system
      .getFontFamilies()
      .then((families) => {
        if (cancelled) return;
        setFontFamilies(uniqueSortedFontFamilies([...DEFAULT_FONT_FAMILIES, ...families]));
      })
      .catch((error) => {
        host.log.warn(
          `[settings] Failed to load system font families: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  return fontFamilies;
}

export function FontFamilyPicker({
  label,
  value,
  onChange,
  placeholder,
  description,
  fontFamilies,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  description: string;
  fontFamilies: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const inputId = `editor-${label.toLowerCase().replace(/\s+/g, "-")}`;
  const listId = `${inputId}-list`;

  const options = useMemo(() => {
    const currentSingleFamily = singleFontFamilyFromCssValue(value);
    return uniqueSortedFontFamilies([
      ...fontFamilies,
      ...(currentSingleFamily ? [currentSingleFamily] : []),
    ]);
  }, [fontFamilies, value]);

  const normalizedSearchValue = searchValue.trim().toLocaleLowerCase();
  const visibleOptions = useMemo(() => {
    if (!normalizedSearchValue) return options.slice(0, 200);
    return options
      .filter((fontFamily) => fontFamily.toLocaleLowerCase().includes(normalizedSearchValue))
      .slice(0, 200);
  }, [normalizedSearchValue, options]);

  const currentSingleFamily = singleFontFamilyFromCssValue(value);
  const exactSearchMatch = options.some(
    (fontFamily) => fontFamily.toLocaleLowerCase() === normalizedSearchValue,
  );
  const customCandidate = searchValue.trim();
  const showCustomCandidate = customCandidate.length > 0 && !exactSearchMatch;

  const clear = useCallback(() => {
    if (value !== "") onChange("");
  }, [onChange, value]);

  const selectValue = useCallback(
    (next: string) => {
      onChange(next);
      setSearchValue("");
      setOpen(false);
    },
    [onChange],
  );

  const selectFontFamily = useCallback(
    (fontFamily: string) => {
      selectValue(fontFamilyNameToCssValue(fontFamily));
    },
    [selectValue],
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-muted-foreground" htmlFor={inputId}>
          {label}
        </label>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Popover
            open={open}
            onOpenChange={(nextOpen) => {
              setOpen(nextOpen);
              if (nextOpen) setSearchValue("");
            }}
          >
            <PopoverTrigger asChild>
              <button
                id={inputId}
                type="button"
                role="combobox"
                aria-controls={listId}
                aria-expanded={open}
                className={cn(
                  "flex h-8 min-w-0 flex-1 items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-left text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  value ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="min-w-0 truncate font-mono">{value || placeholder}</span>
                <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent id={listId} align="end" className="w-[min(29rem,calc(100vw-2rem))] p-0">
              <Command shouldFilter={false}>
                <CommandInput
                  value={searchValue}
                  onValueChange={setSearchValue}
                  placeholder="Search fonts or enter a CSS stack"
                />
                <CommandList className="max-h-72">
                  <CommandGroup heading="Fonts">
                    <CommandItem value="__default__" onSelect={() => selectValue("")}>
                      <Check
                        className={cn("size-3.5", value === "" ? "opacity-100" : "opacity-0")}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm">Theme default</div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {placeholder}
                        </div>
                      </div>
                    </CommandItem>
                    {visibleOptions.map((fontFamily) => {
                      const selected = currentSingleFamily === fontFamily;
                      const cssValue = fontFamilyNameToCssValue(fontFamily);
                      return (
                        <CommandItem
                          key={fontFamily}
                          value={fontFamily}
                          onSelect={() => selectFontFamily(fontFamily)}
                          className="items-start"
                        >
                          <Check
                            className={cn(
                              "mt-0.5 size-3.5",
                              selected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm" style={{ fontFamily: cssValue }}>
                              {fontFamily}
                            </div>
                            <div
                              className="truncate text-[11px] text-muted-foreground"
                              style={{ fontFamily: cssValue }}
                            >
                              Aa The quick brown fox 0123
                            </div>
                          </div>
                        </CommandItem>
                      );
                    })}
                    {showCustomCandidate ? (
                      <CommandItem
                        value={customCandidate}
                        onSelect={() => selectValue(customCandidate)}
                      >
                        <Check className="size-3.5 opacity-0" />
                        <div className="min-w-0">
                          <div className="truncate text-sm">Use custom value</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {customCandidate}
                          </div>
                        </div>
                      </CommandItem>
                    ) : null}
                  </CommandGroup>
                  {visibleOptions.length === 0 && !showCustomCandidate ? (
                    <CommandEmpty>No fonts found.</CommandEmpty>
                  ) : null}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {value ? (
            <button
              type="button"
              aria-label={`Clear ${label.toLowerCase()}`}
              title="Clear"
              onClick={clear}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </div>
      <p className="pl-[5.5rem] text-[10px] text-muted-foreground/70">{description}</p>
    </div>
  );
}

// Exponential slider constants
const MIN_SECS = 5;
const MAX_SECS = 604800; // 7 days
const SLIDER_STEPS = 100;

// Convert slider position (0-100) to seconds (exponential scale)
function sliderToSeconds(position: number): number {
  const ratio = MAX_SECS / MIN_SECS;
  const secs = Math.round(MIN_SECS * ratio ** (position / SLIDER_STEPS));
  return Math.max(MIN_SECS, Math.min(MAX_SECS, secs));
}

// Convert seconds to slider position (0-100)
function secondsToSlider(secs: number): number {
  const ratio = MAX_SECS / MIN_SECS;
  const position = (SLIDER_STEPS * Math.log(secs / MIN_SECS)) / Math.log(ratio);
  return Math.max(0, Math.min(SLIDER_STEPS, Math.round(position)));
}

function RuntimeSection({
  keepAliveSecs,
  onKeepAliveSecsChange,
  redactEnvValuesInOutputs,
  onRedactEnvValuesInOutputsChange,
  importShellEnvironment,
  onImportShellEnvironmentChange,
}: {
  keepAliveSecs: number;
  onKeepAliveSecsChange: (value: number) => void;
  redactEnvValuesInOutputs: boolean;
  onRedactEnvValuesInOutputsChange: (value: boolean) => void;
  importShellEnvironment: boolean;
  onImportShellEnvironmentChange: (value: boolean) => void;
}) {
  const [localValue, setLocalValue] = useState(keepAliveSecs);

  useEffect(() => {
    setLocalValue(keepAliveSecs);
  }, [keepAliveSecs]);

  const sliderPosition = secondsToSlider(localValue);

  return (
    <div className="space-y-4 pt-4 border-t border-border/50">
      <div>
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Runtime
        </span>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Keep Alive</span>
          <span className="text-xs font-medium text-foreground tabular-nums">
            {formatDuration(localValue)}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground/70">
          Time to keep notebook runtime alive after closing
        </p>
      </div>
      <div className="py-2">
        <Slider
          value={[sliderPosition]}
          min={0}
          max={SLIDER_STEPS}
          step={1}
          onValueChange={(v) => setLocalValue(sliderToSeconds(v[0]))}
          onValueCommit={(v) => onKeepAliveSecsChange(sliderToSeconds(v[0]))}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground/70">
        <span>5s</span>
        <span>7 days</span>
      </div>

      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <span className="text-sm text-foreground">Redact environment values in outputs</span>
            <p className="text-[10px] text-muted-foreground/70">
              Masks eligible environment variable values for newly launched or restarted kernels
            </p>
          </div>
          <Switch
            checked={redactEnvValuesInOutputs}
            onCheckedChange={onRedactEnvValuesInOutputsChange}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <span className="text-sm text-foreground">Import shell environment into kernels</span>
            <p className="text-[10px] text-muted-foreground/70">
              Passes your shell startup env vars (API keys, tokens) to newly launched kernels. Pair
              with redaction to keep values out of outputs.
            </p>
          </div>
          <Switch
            checked={importShellEnvironment}
            onCheckedChange={onImportShellEnvironmentChange}
          />
        </div>

        {importShellEnvironment && !redactEnvValuesInOutputs ? (
          <div className="text-[10px] text-amber-600 dark:text-amber-400 pl-3 border-l-2 border-amber-500/40">
            Warning: shell env vars will flow to kernels and into outputs unredacted. Turn on
            "Redact environment values in outputs" to scrub them from cell results and the blob
            store.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EditorSection({
  codeFontFamily,
  markdownFontFamily,
  lineNumbers,
  onCodeFontFamilyChange,
  onMarkdownFontFamilyChange,
  onLineNumbersChange,
}: {
  codeFontFamily: string;
  markdownFontFamily: string;
  lineNumbers: boolean;
  onCodeFontFamilyChange: (value: string) => void;
  onMarkdownFontFamilyChange: (value: string) => void;
  onLineNumbersChange: (value: boolean) => void;
}) {
  const fontFamilies = useAvailableFontFamilies();

  return (
    <div className="space-y-4 pt-4 border-t border-border/50">
      <div>
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Editor
        </span>
      </div>

      <div className="space-y-3">
        <FontFamilyPicker
          label="Code font"
          value={codeFontFamily}
          onChange={onCodeFontFamilyChange}
          placeholder='ui-monospace, "SF Mono", monospace'
          description="Code cells, raw cells, inline code, and code blocks"
          fontFamilies={fontFamilies}
        />
        <FontFamilyPicker
          label="Markdown font"
          value={markdownFontFamily}
          onChange={onMarkdownFontFamilyChange}
          placeholder="system-ui, sans-serif"
          description="Rendered Markdown and Markdown input"
          fontFamilies={fontFamilies}
        />
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <span className="text-sm text-foreground">Line numbers</span>
            <p className="text-[10px] text-muted-foreground/70">
              Show line numbers in notebook editors
            </p>
          </div>
          <Switch checked={lineNumbers} onCheckedChange={onLineNumbersChange} />
        </div>
      </div>
    </div>
  );
}

/** Badge input for managing a list of package names */
function PackageBadgeInput({
  packages,
  onChange,
  placeholder,
}: {
  packages: string[];
  onChange: (packages: string[]) => void;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addPackage = useCallback(
    (raw: string) => {
      const name = raw.trim();
      if (!name) return;
      if (!packages.includes(name)) {
        onChange([...packages, name]);
      }
      setInputValue("");
    },
    [packages, onChange],
  );

  const removePackage = useCallback(
    (index: number) => {
      onChange(packages.filter((_, i) => i !== index));
    },
    [packages, onChange],
  );

  return (
    <div
      className="flex flex-wrap items-center gap-1 min-h-7 rounded-md border bg-muted/50 px-1.5 py-1 cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {packages.map((pkg, i) => (
        <span
          key={`${pkg}-${i}`}
          className="inline-flex items-center gap-0.5 rounded-md bg-secondary text-secondary-foreground pl-1.5 pr-0.5 py-0 text-xs leading-5"
        >
          {pkg}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removePackage(i);
            }}
            className="rounded-sm p-0 hover:bg-muted-foreground/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addPackage(inputValue);
          } else if (e.key === "Backspace" && inputValue === "" && packages.length > 0) {
            removePackage(packages.length - 1);
          }
        }}
        onBlur={() => {
          if (inputValue.trim()) {
            addPackage(inputValue);
          }
        }}
        placeholder={packages.length === 0 ? placeholder : ""}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="flex-1 min-w-[80px] bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none h-5"
      />
    </div>
  );
}

const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export default function App() {
  // Apply theme to window and get theme controls
  // IMPORTANT: Use theme/setTheme/colorTheme/setColorTheme from useSyncedTheme, not a separate
  // useSyncedSettings call, so that setState updates the same instance that applies the DOM theme.
  const { theme, setTheme, colorTheme, setColorTheme } = useSyncedTheme();
  const editorSettings = useNotebookEditorSettings();

  const {
    defaultRuntime,
    setDefaultRuntime,
    defaultPythonEnv,
    setDefaultPythonEnv,
    defaultUvPackages,
    setDefaultUvPackages,
    defaultCondaPackages,
    setDefaultCondaPackages,
    defaultPixiPackages,
    setDefaultPixiPackages,
    installDefaultDataPackages,
    setInstallDefaultDataPackages,
    keepAliveSecs,
    setKeepAliveSecs,
    setEditorCodeFontFamily,
    setEditorMarkdownFontFamily,
    setEditorLineNumbers,
    featureFlags,
    setFeatureFlag,
    telemetryEnabled,
    setTelemetryEnabled,
    redactEnvValuesInOutputs,
    setRedactEnvValuesInOutputs,
    importShellEnvironment,
    setImportShellEnvironment,
    installId,
    rotateInstallId,
    lastDaemonPingAt,
    lastAppPingAt,
    lastMcpPingAt,
  } = useSyncedSettings();

  return (
    <div className="h-full overflow-auto">
      <div className="p-6 space-y-6 max-w-lg mx-auto">
        <h1 className="text-lg font-semibold">Settings</h1>

        {/* Theme */}
        <div className="space-y-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Appearance
          </span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Mode</span>
            <div className="flex items-center gap-1 rounded-md border bg-muted/50 p-0.5">
              {themeOptions.map((option) => {
                const Icon = option.icon;
                const isActive = theme === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setTheme(option.value)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
                      isActive
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Flavor</span>
            <div className="flex items-center gap-1 rounded-md border bg-muted/50 p-0.5">
              {(["classic", "cream"] as const).map((option) => {
                const isActive = colorTheme === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setColorTheme(option)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors capitalize",
                      isActive
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Default Runtime */}
        <div className="space-y-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            New Notebooks
          </span>
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Default Runtime</span>
              <div className="flex items-center gap-1 rounded-md border bg-muted/50 p-0.5">
                <button
                  type="button"
                  onClick={() => setDefaultRuntime("python")}
                  className={cn(
                    "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
                    defaultRuntime === "python"
                      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <PythonIcon className="h-3.5 w-3.5" />
                  Python
                </button>
                <button
                  type="button"
                  onClick={() => setDefaultRuntime("deno")}
                  className={cn(
                    "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
                    defaultRuntime === "deno"
                      ? "bg-teal-500/15 text-teal-600 dark:text-teal-400 shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <DenoIcon className="h-3.5 w-3.5" />
                  Deno
                </button>
              </div>
            </div>
            {defaultRuntime && !isKnownRuntime(defaultRuntime) && (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 mt-1">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">&ldquo;{defaultRuntime}&rdquo;</span> is not a
                  recognized runtime. Click Python or Deno above, or edit{" "}
                  <code className="rounded bg-amber-500/20 px-1">settings.json</code>.
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Python Defaults */}
        <div className="space-y-3">
          <div>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Python Defaults
            </span>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
              Applied to new notebooks without project-based dependencies
            </p>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "auto 1fr" }}>
            {/* Default Python Env */}
            <span className="text-sm text-muted-foreground whitespace-nowrap self-center text-right">
              Environment
            </span>
            <div className="flex items-center gap-1 rounded-md border bg-muted/50 p-0.5 w-fit">
              <button
                type="button"
                onClick={() => setDefaultPythonEnv("uv")}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
                  defaultPythonEnv === "uv"
                    ? "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <UvIcon className="h-3 w-3" />
                uv
              </button>
              <button
                type="button"
                onClick={() => setDefaultPythonEnv("conda")}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
                  defaultPythonEnv === "conda"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <CondaIcon className="h-3 w-3" />
                Conda
              </button>
              <button
                type="button"
                onClick={() => setDefaultPythonEnv("pixi")}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
                  defaultPythonEnv === "pixi"
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <PixiIcon className="h-3 w-3" />
                Pixi
              </button>
            </div>
            {defaultPythonEnv && !isKnownPythonEnv(defaultPythonEnv) && (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 col-span-2 mt-1">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">&ldquo;{defaultPythonEnv}&rdquo;</span> is not a
                  recognized environment. Click uv, Conda, or Pixi above, or edit{" "}
                  <code className="rounded bg-amber-500/20 px-1">settings.json</code>.
                </span>
              </div>
            )}

            <span className="text-sm text-muted-foreground whitespace-nowrap self-center text-right">
              Data Stack
            </span>
            <div className="flex items-center justify-between gap-3 min-h-8">
              <div className="space-y-0.5">
                <span className="text-sm text-foreground">Default data packages</span>
                <p className="text-[10px] text-muted-foreground/70">
                  pandas, polars, matplotlib, plotly, altair
                </p>
              </div>
              <Switch
                checked={installDefaultDataPackages}
                onCheckedChange={setInstallDefaultDataPackages}
              />
            </div>

            {/* Packages */}
            {defaultPythonEnv === "uv" && (
              <>
                <span className="text-sm text-muted-foreground whitespace-nowrap self-center text-right">
                  Packages
                </span>
                <PackageBadgeInput
                  packages={defaultUvPackages}
                  onChange={setDefaultUvPackages}
                  placeholder="Add packages..."
                />
              </>
            )}
            {defaultPythonEnv === "conda" && (
              <>
                <span className="text-sm text-muted-foreground whitespace-nowrap self-center text-right">
                  Packages
                </span>
                <PackageBadgeInput
                  packages={defaultCondaPackages}
                  onChange={setDefaultCondaPackages}
                  placeholder="Add packages..."
                />
              </>
            )}
            {defaultPythonEnv === "pixi" && (
              <>
                <span className="text-sm text-muted-foreground whitespace-nowrap self-center text-right">
                  Packages
                </span>
                <PackageBadgeInput
                  packages={defaultPixiPackages}
                  onChange={setDefaultPixiPackages}
                  placeholder="Add packages..."
                />
              </>
            )}
          </div>
        </div>

        <RuntimeSection
          keepAliveSecs={keepAliveSecs}
          onKeepAliveSecsChange={setKeepAliveSecs}
          redactEnvValuesInOutputs={redactEnvValuesInOutputs}
          onRedactEnvValuesInOutputsChange={setRedactEnvValuesInOutputs}
          importShellEnvironment={importShellEnvironment}
          onImportShellEnvironmentChange={setImportShellEnvironment}
        />

        <EditorSection
          codeFontFamily={editorSettings.codeFontFamily}
          markdownFontFamily={editorSettings.markdownFontFamily}
          lineNumbers={editorSettings.lineNumbers}
          onCodeFontFamilyChange={setEditorCodeFontFamily}
          onMarkdownFontFamilyChange={setEditorMarkdownFontFamily}
          onLineNumbersChange={setEditorLineNumbers}
        />

        <PrivacySection
          telemetryEnabled={telemetryEnabled}
          onTelemetryChange={setTelemetryEnabled}
          installId={installId}
          onRotate={rotateInstallId}
          lastDaemonPingAt={lastDaemonPingAt}
          lastAppPingAt={lastAppPingAt}
          lastMcpPingAt={lastMcpPingAt}
        />

        {/* Feature Flags — only shown when there are flags to display */}
        {FEATURE_FLAGS.length > 0 && (
          <Collapsible className="space-y-2 pt-4 border-t border-border/50">
            <CollapsibleTrigger className="flex items-center gap-1.5 w-full group">
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Feature Flags
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3">
              {FEATURE_FLAGS.map((flag) => (
                <div key={flag.id} className="flex items-center justify-between pl-5">
                  <div className="space-y-0.5">
                    <span className="text-sm text-foreground">{flag.label}</span>
                    <p className="text-[10px] text-muted-foreground/70">{flag.description}</p>
                  </div>
                  <Switch
                    checked={featureFlags[flag.id]}
                    onCheckedChange={(next) => setFeatureFlag(flag.id, next)}
                  />
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
