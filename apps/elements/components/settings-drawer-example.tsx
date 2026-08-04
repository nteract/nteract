"use client";

import { LogOut, Settings } from "lucide-react";
import { useState } from "react";
import {
  NotebookAccountMenu,
  NotebookSettingsDrawer,
  type NotebookActorIdentity,
} from "@/components/notebook";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { ColorTheme } from "@/bindings";
import type { ThemeMode } from "@/hooks/useTheme";
import { Eyebrow } from "@/components/surface-primitives";

const signedInActor: NotebookActorIdentity = {
  id: "user:anaconda:leslie",
  label: "Leslie Dominguez",
  detail: null,
  kind: "human",
};

const scenarios: Array<{
  id: string;
  title: string;
  description: string;
  actor: NotebookActorIdentity | null;
  accountDetail: string | null;
  initialTheme: ThemeMode;
  initialColorTheme?: ColorTheme;
}> = [
  {
    id: "signed-in",
    title: "Signed in",
    description:
      "The full drawer: appearance plus a read-only account block. Sign-out stays a host-owned action.",
    actor: signedInActor,
    accountDetail: "leslie@anaconda.com",
    initialTheme: "system",
    initialColorTheme: "classic",
  },
  {
    id: "cream-palette",
    title: "Cream palette",
    description:
      "Palette is orthogonal to light/dark — each palette defines both modes, so this dark surface is still on a palette choice.",
    actor: signedInActor,
    accountDetail: "leslie@anaconda.com",
    initialTheme: "dark",
    initialColorTheme: "cream",
  },
  {
    id: "no-email",
    title: "No account detail",
    description:
      "Identity without a resolvable email — the secondary line collapses instead of rendering an empty row.",
    actor: signedInActor,
    accountDetail: null,
    initialTheme: "dark",
    initialColorTheme: "classic",
  },
  {
    id: "no-palette-writer",
    title: "No palette writer",
    description:
      "Desktop owns palette through daemon-synced settings, so a host that passes no palette gets the mode row alone rather than a dead control.",
    actor: signedInActor,
    accountDetail: "leslie@anaconda.com",
    initialTheme: "system",
  },
  {
    id: "signed-out",
    title: "Signed out",
    description:
      "A public viewer gets appearance only. No identity means no account section at all.",
    actor: null,
    accountDetail: null,
    initialTheme: "light",
    initialColorTheme: "classic",
  },
];

export function SettingsDrawerExample() {
  return (
    <div className="flex flex-col gap-6">
      {scenarios.map((scenario) => (
        <SettingsDrawerScenario key={scenario.id} scenario={scenario} />
      ))}
    </div>
  );
}

function SettingsDrawerScenario({ scenario }: { scenario: (typeof scenarios)[number] }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(scenario.initialTheme);
  const [colorTheme, setColorTheme] = useState<ColorTheme | undefined>(scenario.initialColorTheme);

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex flex-col gap-1">
        <Eyebrow>{scenario.title}</Eyebrow>
        <p className="text-sm text-muted-foreground">{scenario.description}</p>
      </div>

      <div className="flex items-center gap-3">
        <NotebookAccountMenu
          actor={scenario.actor ?? { ...signedInActor, label: "Public viewer", kind: "public" }}
          accountDetail={scenario.accountDetail}
        >
          <DropdownMenuItem onSelect={() => setOpen(true)}>
            <Settings aria-hidden="true" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem>
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </NotebookAccountMenu>
        <span className="text-xs text-muted-foreground">
          Selected theme: <code>{theme}</code>
          {colorTheme ? (
            <>
              {" · palette: "}
              <code>{colorTheme}</code>
            </>
          ) : null}
        </span>
      </div>

      <NotebookSettingsDrawer
        open={open}
        onOpenChange={setOpen}
        theme={theme}
        onThemeChange={setTheme}
        colorTheme={colorTheme}
        onColorThemeChange={colorTheme ? setColorTheme : undefined}
        actor={scenario.actor}
        accountDetail={scenario.accountDetail}
        accountActions={
          <Button type="button" variant="outline" size="sm" className="self-start">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        }
      />
    </section>
  );
}
