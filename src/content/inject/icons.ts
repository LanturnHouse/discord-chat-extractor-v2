/**
 * Our own simple icons (docs/PLAN.md §7.1): 24x24 viewBox, `fill="currentColor"`, drawn from straight segments only. The
 * colour and the size come from the class names mirrored from Discord's native icon (or from our fallback CSS), never from here.
 */

import { GLYPH_ATTR, GLYPH_VALUE } from '../config';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Block arrow pointing down onto a tray line = "add to the download list". */
export const DOWNLOAD_PATH = 'M10 3h4v8h4.5L12 17.5 5.5 11H10V3Z M5 19.5h14v2H5v-2Z';

/** Check mark = "in the download list". */
export const CHECK_PATH = 'M4.5 12.5l1.7-1.7 3.6 3.6 8-8 1.7 1.7-9.7 9.7-5.3-5.3Z';

/** Cross = "a click takes it out of the list": drawn in the same svg, but shown only while a checked button is hovered or focused. */
export const REMOVE_PATH = 'M6.7 5.3 12 10.6l5.3-5.3 1.4 1.4L13.4 12l5.3 5.3-1.4 1.4L12 13.4l-5.3 5.3-1.4-1.4L10.6 12 5.3 6.7Z';

/** The two STATES of a button: what `setIcon` / `currentIcon` speak about. The cross is no state, it is a hover effect of `check`. */
export type IconName = 'download' | 'check';

const PATHS: Record<IconName, string> = { download: DOWNLOAD_PATH, check: CHECK_PATH };

/** The glyph whose `d` the state decides (the first path; the cross is the second and never changes). */
function stateGlyph(svg: Element): Element | null {
  return svg.querySelector(`path:not([${GLYPH_ATTR}="${GLYPH_VALUE.remove}"])`);
}

/**
 * The svg of a button: the state glyph (switching the icon only swaps its `d`) and, after it, the cross for hovering a checked
 * button. Both are always in the DOM; which one is visible is pure CSS (styles.css, keyed on `data-dce-state` of the button and
 * `:hover` / `:focus-visible`), so the svg keeps its size and the DOM does not change while the pointer moves.
 */
export function createIconSvg(doc: Document, name: IconName, size: number): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const state = doc.createElementNS(SVG_NS, 'path');
  state.setAttribute(GLYPH_ATTR, GLYPH_VALUE.state);
  state.setAttribute('d', PATHS[name]);
  const remove = doc.createElementNS(SVG_NS, 'path');
  remove.setAttribute(GLYPH_ATTR, GLYPH_VALUE.remove);
  remove.setAttribute('d', REMOVE_PATH);
  svg.append(state, remove);
  return svg;
}

/** Shows `name` in an svg made by `createIconSvg`. */
export function setIcon(svg: Element, name: IconName): void {
  const path = stateGlyph(svg);
  if (path && path.getAttribute('d') !== PATHS[name]) path.setAttribute('d', PATHS[name]);
}

/** Which icon an svg currently shows (used by tests and state sync): the STATE glyph, whether or not the pointer is on the button. */
export function currentIcon(svg: Element): IconName | null {
  const d = stateGlyph(svg)?.getAttribute('d');
  return d === PATHS.check ? 'check' : d === PATHS.download ? 'download' : null;
}

// Tiny glyphs for the toast (same drawing rules): check mark, "i", exclamation mark.
export const TOAST_ICON_PATHS = {
  success: CHECK_PATH,
  info: 'M11 6.5h2v2.25h-2V6.5Z M11 10.5h2V17.5h-2v-7Z',
  error: 'M11 5h2v9h-2V5Z M11 16.5h2v2.5h-2v-2.5Z',
} as const;

export type ToastIconName = keyof typeof TOAST_ICON_PATHS;

export function createToastIcon(doc: Document, name: ToastIconName): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', TOAST_ICON_PATHS[name]);
  svg.appendChild(path);
  return svg;
}
