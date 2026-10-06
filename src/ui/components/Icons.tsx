import type { ReactElement, ReactNode, SVGProps } from 'react';

/*
 * Own simple icon set (nothing here is taken from Discord's assets or from an icon library). Every icon is a 24x24 SVG that
 * scales with the font size (1em), takes its colour from `currentColor` and is hidden from assistive technology unless a
 * `title` is given. Re-scoped from v1's common/Icons.tsx.
 *
 *   <Gear />                        decorative, sized by the surrounding font-size
 *   <Warning title="Problem" />     announced as an image named "Problem"
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'ref'> {
  /** Accessible name. Without it the icon is `aria-hidden`. */
  title?: string;
}

interface SvgProps extends IconProps {
  children: ReactNode;
}

/** Outline icons: round-capped 2px strokes. Filled shapes opt out with `FILL`. */
function Svg({ title, children, ...rest }: SvgProps): ReactElement {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
      {...rest}
    >
      {title === undefined ? null : <title>{title}</title>}
      {children}
    </svg>
  );
}

const FILL = { fill: 'currentColor', stroke: 'none' } as const;

/* --- actions ---------------------------------------------------------------------------------------------------- */

export function Download(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
    </Svg>
  );
}

/** Filled caret for the dropdown half of a split button. */
export function DownloadCaret(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path {...FILL} d="M6.5 9.5h11L12 15.5z" />
    </Svg>
  );
}

export function Check(props: IconProps): ReactElement {
  return (
    <Svg strokeWidth={3} {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function Close(props: IconProps): ReactElement {
  return (
    <Svg strokeWidth={2.5} {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

/** A filled triangle with rounded corners ("start this download"). */
export function Play(props: IconProps): ReactElement {
  return (
    <Svg fill="currentColor" strokeWidth={2.2} {...props}>
      <path d="M7.5 5v14L19 12z" />
    </Svg>
  );
}

export function Retry(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5.3h-5.3" />
    </Svg>
  );
}

/* --- navigation ------------------------------------------------------------------------------------------------- */

export function ChevronDown(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Svg>
  );
}

export function ChevronUp(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="m6 14.5 6-6 6 6" />
    </Svg>
  );
}

export function ChevronRight(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="m9.5 6 6 6-6 6" />
    </Svg>
  );
}

/** Arrow pointing left ("back"). */
export function ArrowLeft(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  );
}

export function External(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M13.5 4.5h6v6M19.5 4.5 11 13M17.5 14v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4" />
    </Svg>
  );
}

/* --- places ----------------------------------------------------------------------------------------------------- */

/** A cog: the app settings and "edit this chat's settings" (the item's gear). */
export function Gear(props: IconProps): ReactElement {
  return (
    <Svg strokeWidth={1.8} {...props}>
      <path d="M10.16 5.14 10.55 2.81h2.9l.39 2.33 1.71.71 1.92-1.37 2.05 2.05-1.37 1.92.71 1.71 2.33.39v2.9l-2.33.39-.71 1.71 1.37 1.92-2.05 2.05-1.92-1.37-1.71.71-.39 2.33h-2.9l-.39-2.33-1.71-.71-1.92 1.37-2.05-2.05 1.37-1.92-.71-1.71-2.33-.39v-2.9l2.33-.39.71-1.71L4.48 6.53l2.05-2.05 1.92 1.37z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  );
}

/** Sliders: "settings that apply to everything" (the common settings). */
export function Settings(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20" />
      <circle cx="15" cy="7" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
    </Svg>
  );
}

/** A clock with a counter-clockwise arrow: the download history. */
export function History(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.4 4.2v5.4h5.4M12 7.8V12l3 1.8" />
    </Svg>
  );
}

export function Folder(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4.1c.5 0 1 .3 1.3.7L12 7.8h6.5a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

/* --- status ----------------------------------------------------------------------------------------------------- */

export function Warning(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M12 3.8 21.2 20H2.8z" />
      <path d="M12 10v4.5" />
      <circle {...FILL} cx="12" cy="17.4" r="1.1" />
    </Svg>
  );
}

export function Info(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <circle {...FILL} cx="12" cy="7.6" r="1.2" />
    </Svg>
  );
}

/** A spinning arc (turns while the `dce-icon-spin` class from components.css is applied; always on here). */
export function SpinnerIcon({ className, ...props }: IconProps): ReactElement {
  return (
    <Svg className={className === undefined ? 'dce-icon-spin' : `dce-icon-spin ${className}`} {...props}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Svg>
  );
}

/* --- chat kinds ------------------------------------------------------------------------------------------------- */

export function Hash(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M9.5 4 7.5 20M16.5 4l-2 16M4 9h16.5M3.5 15H20" />
    </Svg>
  );
}

/** A plain speech bubble (a direct message). */
export function ChatBubble(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M5.5 4.5h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H13L8 20.5v-4H5.5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" />
    </Svg>
  );
}

export function Thread(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M6 4v9a5 5 0 0 0 5 5h7" />
      <path d="m14.5 14.5 3.5 3.5-3.5 3.5" />
    </Svg>
  );
}

export function Forum(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4.5 3.5V17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      <path d="M7.5 9h9M7.5 12.5h6" />
    </Svg>
  );
}
