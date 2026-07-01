import { Toggle } from "nteract-elements";
import { WrapText } from "lucide-react";

export function Variants() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Toggle variant="default" aria-label="Toggle word wrap">
        <WrapText />
      </Toggle>
      <Toggle variant="outline" aria-label="Toggle word wrap">
        <WrapText />
      </Toggle>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Toggle size="sm" variant="outline" aria-label="Toggle word wrap">
        <WrapText />
      </Toggle>
      <Toggle size="default" variant="outline" aria-label="Toggle word wrap">
        <WrapText />
      </Toggle>
      <Toggle size="lg" variant="outline" aria-label="Toggle word wrap">
        <WrapText />
      </Toggle>
    </div>
  );
}

export function PressedStates() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Toggle variant="outline" aria-label="Word wrap off">
        <WrapText />
        Word wrap
      </Toggle>
      <Toggle variant="outline" defaultPressed aria-label="Word wrap on">
        <WrapText />
        Word wrap
      </Toggle>
    </div>
  );
}

export function DisabledState() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Toggle variant="outline" disabled aria-label="Word wrap disabled">
        <WrapText />
        Word wrap
      </Toggle>
      <Toggle variant="outline" disabled defaultPressed aria-label="Word wrap disabled pressed">
        <WrapText />
        Word wrap
      </Toggle>
    </div>
  );
}
