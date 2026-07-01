import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Underline } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "nteract-elements";

export function CellTextAlign() {
  return (
    <ToggleGroup type="single" defaultValue="left" style={{ width: 200 }}>
      <ToggleGroupItem value="left" aria-label="Align left">
        <AlignLeft className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="center" aria-label="Align center">
        <AlignCenter className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="right" aria-label="Align right">
        <AlignRight className="h-4 w-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function MarkdownFormatting() {
  return (
    <ToggleGroup type="multiple" defaultValue={["bold"]} style={{ width: 200 }}>
      <ToggleGroupItem value="bold" aria-label="Bold">
        <Bold className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="italic" aria-label="Italic">
        <Italic className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="underline" aria-label="Underline">
        <Underline className="h-4 w-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function OutlineVariant() {
  return (
    <ToggleGroup type="single" variant="outline" defaultValue="table" style={{ width: 260 }}>
      <ToggleGroupItem value="table">Table</ToggleGroupItem>
      <ToggleGroupItem value="json">JSON</ToggleGroupItem>
      <ToggleGroupItem value="chart">Chart</ToggleGroupItem>
    </ToggleGroup>
  );
}
