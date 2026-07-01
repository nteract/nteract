import { Checkbox, Input, Label, Switch } from "nteract-elements";

export function WithInput() {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="conda-env">Conda environment</Label>
      <Input id="conda-env" defaultValue="ds-bundle" />
    </div>
  );
}

export function WithCheckbox() {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id="show-line-numbers" defaultChecked />
      <Label htmlFor="show-line-numbers">Show line numbers</Label>
    </div>
  );
}

export function WithSwitch() {
  return (
    <div className="flex items-center gap-2">
      <Switch id="auto-run" />
      <Label htmlFor="auto-run">Run cell on save</Label>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id="gpu-runtime" disabled />
      <Label htmlFor="gpu-runtime" className="peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
        GPU runtime (unavailable)
      </Label>
    </div>
  );
}
