"use client";

import { useState } from "react";
import {
  ManagedPythonPackages,
  type ManagedPythonPackagesProps,
} from "../../../src/components/environment/ManagedPythonPackages";
import { EnvironmentPackageSummaryPanel } from "../../../src/components/environment/EnvironmentPackageSummaryPanel";
import { Button } from "../../../src/components/ui/button";

const states = ["ready", "installing", "error", "restoring", "unavailable", "peer"] as const;
type Fixture = (typeof states)[number];

export function CloudPackagesExample() {
  const [fixture, setFixture] = useState<Fixture>("ready");
  const [requirements, setRequirements] = useState(["snowballstemmer>=2,<4"]);
  const [narrow, setNarrow] = useState(false);
  const phase: ManagedPythonPackagesProps["phase"] = fixture === "peer" ? "ready" : fixture;
  return (
    <div className="not-prose space-y-6">
      <div className="flex flex-wrap gap-2" aria-label="Package fixture state">
        {states.map((state) => (
          <Button
            key={state}
            variant={fixture === state ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFixture(state)}
          >
            {state}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={() => setNarrow(!narrow)}>
          {narrow ? "Normal width" : "Narrow width"}
        </Button>
      </div>
      <div className="grid items-start gap-8 xl:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Current cloud package rail</h2>
          <div className="max-w-80 border-t border-border py-4">
            <EnvironmentPackageSummaryPanel
              packages={{
                summary: "uv · 1 package",
                sections: [
                  {
                    manager: "uv",
                    label: "uv",
                    dependencies: ["snowballstemmer>=2,<4"],
                    details: [],
                  },
                ],
              }}
            />
          </div>
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Cloud Python packages</h2>
          <div
            className="border-t border-border py-4"
            style={{ width: narrow ? 240 : 320, maxWidth: "100%" }}
            data-testid="cloud-packages-proposed"
          >
            <ManagedPythonPackages
              requirements={requirements}
              installed={["numpy==2.2.5", "pandas==2.3.0", "snowballstemmer==3.0.1"]}
              phase={phase}
              readOnly={fixture === "peer"}
              needsRestart={fixture === "error"}
              error={
                fixture === "error"
                  ? "Installation failed. Some packages may have changed; saved requirements are unchanged."
                  : null
              }
              onAdd={async (requirement) => {
                setRequirements([...requirements, requirement]);
                return true;
              }}
              onRemove={async (requirement) =>
                setRequirements(requirements.filter((item) => item !== requirement))
              }
              onRestart={() => setFixture("restoring")}
              onClear={async () => setRequirements([])}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
