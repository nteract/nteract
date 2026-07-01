import { ThemeToggle } from "nteract-elements";

export function Light() {
  return <ThemeToggle theme="light" onThemeChange={() => {}} />;
}

export function Dark() {
  return <ThemeToggle theme="dark" onThemeChange={() => {}} />;
}

export function System() {
  return <ThemeToggle theme="system" onThemeChange={() => {}} />;
}
