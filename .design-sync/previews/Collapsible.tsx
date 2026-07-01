import { ChevronsUpDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "nteract-elements";

export function HiddenCells() {
  return (
    <Collapsible defaultOpen style={{ width: 380 }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">3 hidden cells</span>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
          >
            <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
          <div className="rounded border border-border px-2 py-1 font-mono">
            df = pd.read_parquet("events.parquet")
          </div>
          <div className="rounded border border-border px-2 py-1 font-mono">
            df.dropna(subset=["user_id"], inplace=True)
          </div>
          <div className="rounded border border-border px-2 py-1 font-mono">
            df.to_parquet("events_clean.parquet")
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function StackTraceDetails() {
  return (
    <Collapsible defaultOpen style={{ width: 380 }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-destructive">
          KeyError: &apos;user_id&apos;
        </span>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
          >
            <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs text-muted-foreground">
          {"Cell In[12], line 4\n      2 df = pd.DataFrame(records)\n----> 4 df[\"user_id\"]"}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
