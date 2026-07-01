import { Label, Textarea } from "nteract-elements";

export function Default() {
  return (
    <Textarea defaultValue={"import pandas as pd\n\ndf = pd.read_csv('sales.csv')\ndf.head()"} />
  );
}

export function WithPlaceholder() {
  return <Textarea placeholder="Describe what this notebook does…" />;
}

export function LabeledField() {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="cell-note">Cell note</Label>
      <Textarea
        id="cell-note"
        defaultValue="Recomputes rolling averages before the plotting cell below."
      />
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="readonly-log" className="text-muted-foreground">
        Kernel startup log
      </Label>
      <Textarea
        id="readonly-log"
        disabled
        defaultValue={"Starting IPython kernel...\nKernel ready in 842ms"}
      />
    </div>
  );
}
