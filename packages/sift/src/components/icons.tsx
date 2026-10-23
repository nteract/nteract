/**
 * The three icons Sift renders, inlined so the package carries no icon
 * library dependency (hosts pin their own lucide-react version and would
 * otherwise install a second copy).
 *
 * Path data is from Lucide (https://lucide.dev), ISC license; see
 * LICENSE.lucide in this directory and lib/THIRD_PARTY_NOTICES.md. The SVG
 * attributes match what lucide-react emits, so the button styles that size
 * and color `svg` children keep working.
 */
import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Icon({ paths, ...props }: IconProps & { paths: readonly string[] }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function ChevronLeft(props: IconProps) {
  return <Icon paths={["m15 18-6-6 6-6"]} {...props} />;
}

export function ChevronRight(props: IconProps) {
  return <Icon paths={["m9 18 6-6-6-6"]} {...props} />;
}

export function X(props: IconProps) {
  return <Icon paths={["M18 6 6 18", "m6 6 12 12"]} {...props} />;
}
