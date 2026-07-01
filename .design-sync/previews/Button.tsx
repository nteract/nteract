import { Button } from "nteract-elements";
import { Play, RefreshCw, Trash2 } from "lucide-react";

export function Variants() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Button>Run cell</Button>
      <Button variant="secondary">Add cell</Button>
      <Button variant="outline">Restart kernel</Button>
      <Button variant="ghost">Clear outputs</Button>
      <Button variant="destructive">Delete</Button>
      <Button variant="link">View docs</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Run cell">
        <Play />
      </Button>
    </div>
  );
}

export function WithIcons() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Button>
        <Play /> Run all
      </Button>
      <Button variant="outline">
        <RefreshCw /> Restart
      </Button>
      <Button variant="destructive">
        <Trash2 /> Delete
      </Button>
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Button disabled>Run cell</Button>
      <Button variant="outline" disabled>
        Restart kernel
      </Button>
    </div>
  );
}
