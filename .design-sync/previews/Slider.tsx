import { Label, Slider } from "nteract-elements";

export function SingleThumb() {
  return (
    <div className="flex flex-col gap-1.5" style={{ width: 220 }}>
      <Label htmlFor="cell-width">Cell width (%)</Label>
      <Slider id="cell-width" defaultValue={[75]} min={40} max={100} step={5} />
    </div>
  );
}

export function OutputOpacity() {
  return (
    <div className="flex flex-col gap-1.5" style={{ width: 220 }}>
      <Label htmlFor="output-opacity">Stale output opacity</Label>
      <Slider id="output-opacity" defaultValue={[40]} min={0} max={100} step={1} />
    </div>
  );
}

export function Range() {
  return (
    <div className="flex flex-col gap-1.5" style={{ width: 220 }}>
      <Label htmlFor="viewport-range">Rows to display</Label>
      <Slider id="viewport-range" defaultValue={[20, 80]} min={0} max={100} step={5} />
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-col gap-1.5" style={{ width: 220 }}>
      <Label htmlFor="locked-width" className="text-muted-foreground">
        Cell width (locked)
      </Label>
      <Slider id="locked-width" defaultValue={[60]} min={40} max={100} step={5} disabled />
    </div>
  );
}
