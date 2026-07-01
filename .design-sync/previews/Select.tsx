import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from "nteract-elements";

export function KernelPicker() {
  return (
    <div style={{ width: 320 }}>
      <div className="mb-2 text-sm font-medium text-foreground">Kernel</div>
      <Select defaultOpen>
        <SelectTrigger>
          <SelectValue placeholder="Select a kernel" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Python</SelectLabel>
            <SelectItem value="py312">Python 3.12</SelectItem>
            <SelectItem value="py311">Python 3.11</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Other runtimes</SelectLabel>
            <SelectItem value="deno">Deno 2.1</SelectItem>
            <SelectItem value="ir">R (IRkernel)</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
