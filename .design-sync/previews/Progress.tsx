import { Progress } from "nteract-elements";

export function Starting() {
  return (
    <div className="flex flex-col gap-1.5" style={{ width: 240 }}>
      <span className="text-sm text-muted-foreground">Installing dependencies (numpy)</span>
      <Progress value={33} />
    </div>
  );
}

export function InProgress() {
  return (
    <div className="flex flex-col gap-1.5" style={{ width: 240 }}>
      <span className="text-sm text-muted-foreground">Restoring uv environment</span>
      <Progress value={66} />
    </div>
  );
}

export function Complete() {
  return (
    <div className="flex flex-col gap-1.5" style={{ width: 240 }}>
      <span className="text-sm text-muted-foreground">Kernel ready</span>
      <Progress value={100} />
    </div>
  );
}
