/**
 * Our row button: creation, look and state (docs/PLAN.md §4, §7.1).
 *
 * The look is mirrored: the button element gets the class names of the row's native icon (`iconItem_*`, or `closeButton_*`
 * in a DM) and its svg gets the native svg's class (`actionIcon_*` / `closeIcon_*`), so Discord's own selected / size /
 * colour rules apply to it. Where a row has no native icon, the classes learned from another row are used (`cache`; a category
 * row has no native icon of a fitting kind either, so it too copies the learned channel classes); where nothing is known our own
 * fallback CSS (`styles.css`) draws it (`fallback`).
 *
 * Every button is ALWAYS visible (PLAN §2 "버튼 표시"): Discord's classes hide their icon until the row is hovered, so each
 * button also carries our own class (`FORCE_CLASS`) that forces `display` with `!important`.
 */
import { FORCE_CLASS, KEY_ATTR, KIND_ATTR, OWN, OWN_VALUE, SRC_ATTR, STATE_ATTR } from '../config';
import type { NativeIcon, RowKind } from '../dom/rows';
import type { Strings } from '../i18n';
import type { ClassCache } from './classCache';
import { createIconSvg, currentIcon, setIcon, type IconName } from './icons';

export type StyleSource = 'native' | 'cache' | 'fallback';

export interface ButtonStyle {
  source: StyleSource;
  /** The class names mirrored from Discord (or our fallback class); '' = none. `FORCE_CLASS` is added on top by `applyStyle`. */
  buttonClass: string;
  /** class of our svg ('' = none). */
  svgClass: string;
  /** DM rows: the wrapper `div` between the button and the svg (null = the svg is a direct child). */
  inner: { className: string } | null;
  /** `width` / `height` of the svg (the native svg's own size, else 16). */
  size: number;
}

export interface ButtonState {
  /** Rows: the chat is in the list. Category buttons: every channel of the category is in the list. */
  queued: boolean;
  label: string;
}

const DEFAULT_SIZE = 16;

/** Classes of the fallback look (docs/PLAN.md §4): everything about them is in styles.css. */
export const FALLBACK_BUTTON_CLASS = 'dce-row-btn';
export const FALLBACK_SVG_CLASS = 'dce-row-icon';
const FALLBACK: ButtonStyle = {
  source: 'fallback',
  buttonClass: FALLBACK_BUTTON_CLASS,
  svgClass: FALLBACK_SVG_CLASS,
  inner: null,
  size: DEFAULT_SIZE,
};

/** Where the look of a row's button comes from: its native icon, else what was learned, else our own CSS. */
export function planStyle(kind: RowKind, native: NativeIcon | null, cache: ClassCache): ButtonStyle {
  // A category row has no icon of its own to copy: it takes the channel icon classes learned from other rows.
  const cacheKind = kind === 'dm' ? 'dm' : 'channel';
  if (native?.buttonClass) {
    return {
      source: 'native',
      buttonClass: native.buttonClass,
      svgClass: native.svgClass ?? cache.svgClass(cacheKind) ?? '',
      inner: native.inner ? { className: native.inner.className ?? '' } : null,
      size: native.svgSize ?? DEFAULT_SIZE,
    };
  }
  const cachedButton = cache.buttonClass(cacheKind);
  if (cachedButton) {
    return {
      source: 'cache',
      buttonClass: cachedButton,
      svgClass: cache.svgClass(cacheKind) ?? '',
      inner: kind === 'dm' ? { className: '' } : null,
      size: DEFAULT_SIZE,
    };
  }
  return FALLBACK;
}

/** Tooltip text = aria-label of a row's button: the state decides between "add" and "remove". */
export function labelFor(
  kind: RowKind,
  queued: boolean,
  strings: Pick<Strings, 'tooltipAdd' | 'tooltipRemove' | 'tooltipCategory' | 'tooltipCategoryRemove'>,
): string {
  if (kind === 'category') return queued ? strings.tooltipCategoryRemove : strings.tooltipCategory;
  return queued ? strings.tooltipRemove : strings.tooltipAdd;
}

/** Writes an attribute only when it differs (our own writes should not make needless DOM noise). */
export function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** `class` the same way: '' removes it. */
export function setClassAttr(el: Element, value: string): void {
  if (value === '') {
    if (el.hasAttribute('class')) el.removeAttribute('class');
  } else if (el.getAttribute('class') !== value) {
    el.setAttribute('class', value);
  }
}

/** The mirrored class names plus the class that keeps the button visible. */
function withForce(mirrored: string): string {
  return mirrored === '' ? FORCE_CLASS : `${mirrored} ${FORCE_CLASS}`;
}

function buttonSvg(button: Element): SVGElement | null {
  return button.querySelector('svg');
}

/** The svg (+ the DM wrapper) of a button, laid out as the style says. */
function buildContent(doc: Document, style: ButtonStyle, icon: IconName): Node {
  const svg = createIconSvg(doc, icon, style.size);
  if (!style.inner) return svg;
  const inner = doc.createElement('div');
  inner.appendChild(svg);
  return inner;
}

/** Applies `style` to a button: idempotent, and it rebuilds the content only when the DM wrapper has to appear or go. */
export function applyStyle(doc: Document, button: HTMLElement, style: ButtonStyle): void {
  const wrapped = button.firstElementChild?.tagName === 'DIV';
  if (wrapped !== (style.inner !== null) || !buttonSvg(button)) {
    const icon = currentIcon(button) ?? 'download';
    button.replaceChildren(buildContent(doc, style, icon));
  }
  setClassAttr(button, withForce(style.buttonClass));
  setAttr(button, SRC_ATTR, style.source);
  const inner = button.firstElementChild;
  if (style.inner && inner && inner.tagName === 'DIV') setClassAttr(inner, style.inner.className);
  const svg = buttonSvg(button);
  if (svg) {
    setClassAttr(svg, style.svgClass);
    setAttr(svg, 'width', String(style.size));
    setAttr(svg, 'height', String(style.size));
  }
}

/** A new button (not yet in the page): download icon, idle, with `style` applied. */
export function createButton(doc: Document, style: ButtonStyle): HTMLElement {
  const button = doc.createElement('div');
  button.setAttribute(OWN, OWN_VALUE.button);
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.setAttribute('draggable', 'false');
  button.appendChild(buildContent(doc, style, 'download'));
  applyStyle(doc, button, style);
  return button;
}

/** Ties a button to its row (the id is what the queue is keyed by; the kind drives CSS). */
export function identifyButton(button: HTMLElement, id: string, kind: RowKind): void {
  setAttr(button, KEY_ATTR, id);
  setAttr(button, KIND_ATTR, kind);
}

/** Icon (download arrow / check) and label. */
export function applyState(button: HTMLElement, state: ButtonState): void {
  setAttr(button, STATE_ATTR, state.queued ? 'queued' : 'idle');
  setAttr(button, 'aria-label', state.label);
  const svg = buttonSvg(button);
  if (svg) setIcon(svg, state.queued ? 'check' : 'download');
}
