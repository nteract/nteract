import { HoverCard, HoverCardTrigger, HoverCardContent, Badge } from "nteract-elements";
import { Package } from "lucide-react";

export function PackageHoverCard() {
  return (
    <div style={{ width: 300, display: "flex", justifyContent: "center", paddingTop: 24 }}>
      <HoverCard open>
        <HoverCardTrigger asChild>
          <span className="cursor-pointer rounded border border-input px-2 py-1 text-sm font-mono">
            polars==1.9.0
          </span>
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="flex gap-3">
            <Package className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold">polars</h4>
                <Badge variant="secondary">1.9.0</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Fast, multi-threaded DataFrame library. Resolved via uv from PyPI.
              </p>
              <p className="text-xs text-muted-foreground">Installed in .venv · 42 MB</p>
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}
