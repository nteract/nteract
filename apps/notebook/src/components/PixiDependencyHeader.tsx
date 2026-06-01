import { useCallback, useState } from "react";
import { PixiDependencyPanel, type PixiDependencyPanelProps } from "@/components/environment";
import { addPixiDependency, removePixiDependency, usePixiDeps } from "../lib/notebook-metadata";

export type PixiDependencyHeaderProps = Omit<
  PixiDependencyPanelProps,
  "inlineDependencies" | "loading" | "onAdd" | "onRemove"
>;

export function PixiDependencyHeader(props: PixiDependencyHeaderProps) {
  const pixiDeps = usePixiDeps();
  const [loading, setLoading] = useState(false);

  const handleAdd = useCallback(async (pkg: string) => {
    if (!pkg.trim()) return;
    setLoading(true);
    try {
      await addPixiDependency(pkg.trim());
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRemove = useCallback(async (pkg: string) => {
    setLoading(true);
    try {
      await removePixiDependency(pkg);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <PixiDependencyPanel
      {...props}
      inlineDependencies={pixiDeps?.dependencies ?? []}
      loading={loading}
      onAdd={handleAdd}
      onRemove={handleRemove}
    />
  );
}
