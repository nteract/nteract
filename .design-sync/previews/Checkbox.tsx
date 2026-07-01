import { Checkbox, Label } from "nteract-elements";

export function States() {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <Checkbox />
      <Checkbox defaultChecked />
      <Checkbox disabled />
      <Checkbox disabled defaultChecked />
    </div>
  );
}

export function LabeledRow() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="flex items-center gap-2">
        <Checkbox id="autosave" defaultChecked />
        <Label htmlFor="autosave">Autosave notebook</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="trust-outputs" />
        <Label htmlFor="trust-outputs">Trust cell outputs on open</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="restart-on-crash" disabled />
        <Label htmlFor="restart-on-crash" className="text-muted-foreground">
          Restart kernel on crash
        </Label>
      </div>
    </div>
  );
}
