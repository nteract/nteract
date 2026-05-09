import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names while preserving Tailwind conflict rules. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
