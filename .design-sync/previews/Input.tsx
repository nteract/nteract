import { Input, Label } from "nteract-elements";

export function Default() {
  return <Input defaultValue="numpy, pandas, matplotlib" />;
}

export function WithPlaceholder() {
  return <Input placeholder="Search cells, outputs, and variables…" />;
}

export function LabeledField() {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="kernel-name">Kernel display name</Label>
      <Input id="kernel-name" defaultValue="Python 3.12 (nteract)" />
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="notebook-path" className="text-muted-foreground">
        Notebook path
      </Label>
      <Input id="notebook-path" disabled defaultValue="/Users/kelly/notebooks/eda.ipynb" />
    </div>
  );
}

export function Types() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="timeout">Execution timeout (seconds)</Label>
        <Input id="timeout" type="number" defaultValue={30} min={0} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="daemon-token">Daemon auth token</Label>
        <Input id="daemon-token" type="password" defaultValue="sk-runt-••••••••" />
      </div>
    </div>
  );
}
