export interface LockedWheel {
  name: string;
  version: string;
  filename: string;
  url: string;
  sha256: string;
  size: number;
  dependencies: string[];
}
export interface PackageManifest {
  version: 1;
  pyodide: string;
  requirements: string[];
  wheels: LockedWheel[];
}
export type PackageResult =
  | { status: "ready"; installed: string[]; manifest: PackageManifest }
  | { status: "error"; error: string; needs_restart: boolean };
export const PACKAGE_RUNTIME_VERSION: string;
export function packageName(requirement: string): string | undefined;
export function packageManifest(value: unknown): PackageManifest;
export function removeRequirement(manifest: PackageManifest, requirement: string): PackageManifest;
