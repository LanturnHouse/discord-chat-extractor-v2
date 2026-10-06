/**
 * Captures Discord's theme for the popup (docs/PLAN.md §4, §7.4): the CSS variables the popup reuses, read from the
 * computed style of `<html>`, plus the `theme-*` classes, the colour scheme and the page language. Written to
 * `LOCAL.theme`, debounced, and again whenever `<html>`'s class or lang changes. `<html>` itself is only ever read: no class,
 * no attribute is added to it (React-Helmet owns it).
 */
import type { ThemeTokens } from '@/shared/types';
import { TIMING } from './config';

/** The variables of docs/PLAN.md §4 (theme variables, measured live). Values are `color-mix(...)` strings and the like. */
export const THEME_VARS: readonly string[] = [
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
  // icons and buttons
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
];

/** `theme-light` = light. Every other theme (`theme-dark`, `theme-darker`, `theme-midnight`, `theme-onyx`) and none at all = dark. */
function schemeOf(themeClasses: readonly string[]): 'dark' | 'light' {
  return themeClasses.includes('theme-light') ? 'light' : 'dark';
}

/** Reads the current theme of the page. Variables Discord does not define are left out. */
export function captureTheme(doc: Document, now: number = Date.now()): ThemeTokens {
  const root = doc.documentElement;
  const themeClasses = Array.from(root.classList).filter((name) => name.startsWith('theme-'));
  const view = doc.defaultView;
  const style = view ? view.getComputedStyle(root) : null;
  const vars: Record<string, string> = {};
  if (style) {
    for (const name of THEME_VARS) {
      const value = style.getPropertyValue(name).trim();
      if (value !== '') vars[name] = value;
    }
  }
  return { scheme: schemeOf(themeClasses), themeClasses, vars, lang: root.lang ?? '', capturedAt: now };
}

/** The part of the tokens that identifies a theme (so an unchanged theme is not written again). */
function signature(tokens: ThemeTokens): string {
  return JSON.stringify([tokens.scheme, tokens.themeClasses, tokens.vars, tokens.lang]);
}

export interface ThemeWatcherDeps {
  doc: Document;
  /** Persists the tokens (`LOCAL.theme`). */
  write(tokens: ThemeTokens): void;
  /** Called after each capture (the owner refreshes language-dependent labels). */
  onCaptured?(tokens: ThemeTokens): void;
}

/** Captures once shortly after start, then again (debounced) whenever `<html>` changes its class or lang. */
export class ThemeWatcher {
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = '';

  constructor(private readonly deps: ThemeWatcherDeps) {}

  start(): void {
    if (this.observer) return;
    const observer = new MutationObserver(() => this.schedule());
    observer.observe(this.deps.doc.documentElement, { attributes: true, attributeFilter: ['class', 'lang'] });
    this.observer = observer;
    this.schedule();
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.capture(), TIMING.themeDebounceMs);
  }

  /** Reads the theme now and writes it when it differs from the last one written. */
  capture(): ThemeTokens {
    clearTimeout(this.timer);
    const tokens = captureTheme(this.deps.doc);
    const sig = signature(tokens);
    if (sig !== this.last) {
      this.last = sig;
      this.deps.write(tokens);
    }
    this.deps.onCaptured?.(tokens);
    return tokens;
  }

  stop(): void {
    clearTimeout(this.timer);
    this.observer?.disconnect();
    this.observer = null;
  }
}
