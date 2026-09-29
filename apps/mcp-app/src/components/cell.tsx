import { SharedCellOutputs, type SharedCellOutputsProps } from "./shared-cell-outputs";

export function Cell(props: SharedCellOutputsProps) {
  return (
    <div className="cell">
      <SharedCellOutputs {...props} />
    </div>
  );
}
