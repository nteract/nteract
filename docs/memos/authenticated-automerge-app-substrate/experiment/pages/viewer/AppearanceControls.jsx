import React, { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { createThemeStore } from "./theme.mjs";

const themeStore = createThemeStore(globalThis.window);
const modes = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function AppearanceControls() {
  const { mode } = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot);
  return (
    <fieldset className="appearance-controls">
      <legend>Appearance</legend>
      <div className="appearance-modes" role="group" aria-label="Color mode">
        {modes.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => themeStore.setMode(value)}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
