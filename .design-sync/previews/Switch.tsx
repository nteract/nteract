import { Label, Switch } from "nteract-elements";

export function States() {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <Switch />
      <Switch defaultChecked />
      <Switch disabled />
      <Switch disabled defaultChecked />
    </div>
  );
}

export function LabeledRow() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="flex items-center gap-2">
        <Switch id="auto-format" defaultChecked />
        <Label htmlFor="auto-format">Auto-format cells on run</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="word-wrap" />
        <Label htmlFor="word-wrap">Word wrap in editor</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="cloud-sync" disabled />
        <Label htmlFor="cloud-sync" className="text-muted-foreground">
          Sync notebook to cloud
        </Label>
      </div>
    </div>
  );
}
