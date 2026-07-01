import { Label, RadioGroup, RadioGroupItem } from "nteract-elements";

export function ComputePlacement() {
  return (
    <RadioGroup defaultValue="gpu" style={{ width: 320 }}>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="local" id="compute-local" />
        <Label htmlFor="compute-local">Local kernel</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="gpu" id="compute-gpu" />
        <Label htmlFor="compute-gpu">GPU worker (A100)</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="cloud" id="compute-cloud" />
        <Label htmlFor="compute-cloud">Cloud runtime</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="tpu" id="compute-tpu" disabled />
        <Label htmlFor="compute-tpu" className="text-muted-foreground">
          TPU pod (unavailable)
        </Label>
      </div>
    </RadioGroup>
  );
}

export function OutputFormat() {
  return (
    <RadioGroup defaultValue="parquet" style={{ width: 320 }}>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="parquet" id="format-parquet" />
        <Label htmlFor="format-parquet">Parquet</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="csv" id="format-csv" />
        <Label htmlFor="format-csv">CSV</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="json" id="format-json" />
        <Label htmlFor="format-json">JSON Lines</Label>
      </div>
    </RadioGroup>
  );
}
