import type { ThemeTokens } from '@/shared';

/**
 * The Discord CSS variables the content script collects into `dce.theme` (docs/PLAN.md §4) and the popup may apply. Anything
 * else in the stored object is ignored: the value is written by a script running next to a web page, so the popup treats it as
 * untrusted data and only ever sets variables from this list.
 */
export const THEME_VAR_NAMES: readonly string[] = Object.freeze([
  '--background-base-low',
  '--background-base-lower',
  '--background-base-lowest',
  '--background-surface-high',
  '--background-surface-higher',
  '--background-surface-highest',
  '--background-mod-subtle',
  '--background-mod-normal',
  '--background-mod-strong',
  '--background-mod-muted',
  '--border-subtle',
  '--border-normal',
  '--border-strong',
  '--brand-500',
  '--brand-560',
  '--control-brand-foreground',
  '--text-default',
  '--text-muted',
  '--text-strong',
  '--text-subtle',
  '--text-link',
  '--icon-default',
  '--icon-muted',
  '--icon-strong',
  '--interactive-muted',
  '--input-background-default',
  '--input-border-default',
  '--input-border-hover',
  '--input-border-active',
  '--modal-background',
  '--modal-footer-background',
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--status-danger',
  '--status-positive',
  '--status-warning',
  '--font-primary',
  '--channels-default',
  '--interactive-text-default',
  '--interactive-text-hover',
  '--interactive-text-active',
  '--interactive-icon-default',
  '--interactive-icon-hover',
  '--interactive-icon-active',
  '--interactive-background-hover',
  '--interactive-background-active',
  '--interactive-background-selected',
  '--channel-icon',
]);

const ALLOWED = new Set(THEME_VAR_NAMES);
const MAX_VALUE_LENGTH = 400;
// A custom property value may not carry anything that loads a resource or breaks out of the declaration.
const UNSAFE_VALUE = /[;{}<>\\@]|url\s*\(|image-set\s*\(|expression\s*\(|javascript:/i;

/** The entries of `vars` that are on the allow-list and have a plain, short value; everything else is dropped. */
export function sanitizeThemeVars(vars: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof vars !== 'object' || vars === null) return result;
  for (const [name, value] of Object.entries(vars)) {
    if (!ALLOWED.has(name) || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MAX_VALUE_LENGTH || UNSAFE_VALUE.test(trimmed)) continue;
    result[name] = trimmed;
  }
  return result;
}

/** Which variables this module set on which element, so a new theme can remove the ones the old theme had and the new one lacks. */
const appliedNames = new WeakMap<HTMLElement, Set<string>>();

/**
 * Applies the theme the content script stored (docs/PLAN.md §7.4): the Discord variables go onto `root` as custom properties and
 * `data-theme` says which fallback palette (theme.css) the missing ones use. No tokens (the user never opened Discord) = the
 * built-in Discord dark palette.
 */
export function applyTheme(tokens: ThemeTokens | null, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = tokens?.scheme === 'light' ? 'light' : 'dark';
  const next = sanitizeThemeVars(tokens?.vars);
  const previous = appliedNames.get(root);
  if (previous !== undefined) {
    for (const name of previous) if (!(name in next)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(next)) root.style.setProperty(name, value);
  appliedNames.set(root, new Set(Object.keys(next)));
}
