// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { ThemeTokens } from '@/shared';
import css from '@/ui/theme/theme.css?raw';
import { THEME_VAR_NAMES, applyTheme, sanitizeThemeVars } from '@/ui/theme/applyTheme';

const tokens = (patch: Partial<ThemeTokens> = {}): ThemeTokens => ({ scheme: 'dark', themeClasses: ['theme-dark'], vars: {}, lang: 'ko', capturedAt: 1, ...patch });

afterEach(() => {
  applyTheme(null);
  document.documentElement.removeAttribute('data-theme');
});

describe('sanitizeThemeVars (the values come from a script that runs next to a web page: untrusted data)', () => {
  it('keeps the Discord variables of docs/PLAN.md §4 with a plain value', () => {
    expect(sanitizeThemeVars({ '--text-default': 'hsl(220 13% 91% / 1)', '--brand-500': ' #5865f2 ' })).toEqual({
      '--text-default': 'hsl(220 13% 91% / 1)',
      '--brand-500': '#5865f2',
    });
  });

  it('keeps a color-mix() value as Discord computes it', () => {
    const value = 'color-mix(in oklab, hsl(235 85.6% 64.7% / 1) 100%, #000 0%)';
    expect(sanitizeThemeVars({ '--brand-500': value })).toEqual({ '--brand-500': value });
  });

  it('drops a name that is not on the list, however harmless it looks', () => {
    expect(sanitizeThemeVars({ '--my-own-thing': 'red', color: 'red', 'background-image': 'none', '--text-default': 'red' })).toEqual({ '--text-default': 'red' });
  });

  it('drops a value that could load something or break out of the declaration', () => {
    const bad = [
      'url(https://evil.example/x.png)',
      'url( "x" )',
      'red; background: url(x)',
      'red } body { display: none',
      'image-set("x" 1x)',
      '@import "x"',
      'expression(alert(1))',
      'javascript:alert(1)',
      '<script>',
      'a\\b',
      'x'.repeat(401),
      '',
      '   ',
    ];
    for (const value of bad) expect(sanitizeThemeVars({ '--text-default': value }), value.slice(0, 30)).toEqual({});
  });

  it('drops values that are not strings and input that is not an object', () => {
    expect(sanitizeThemeVars({ '--text-default': 5, '--text-muted': null, '--text-strong': ['red'] })).toEqual({});
    for (const input of [null, undefined, 'x', 5, []]) expect(sanitizeThemeVars(input)).toEqual({});
  });

  it('the allow-list is exactly the variables of the plan (no duplicates, all custom properties)', () => {
    expect(new Set(THEME_VAR_NAMES).size).toBe(THEME_VAR_NAMES.length);
    for (const name of THEME_VAR_NAMES) expect(name).toMatch(/^--[a-z0-9-]+$/);
    for (const required of ['--background-base-low', '--brand-500', '--control-brand-foreground', '--text-default', '--status-danger', '--interactive-icon-hover', '--channel-icon']) {
      expect(THEME_VAR_NAMES).toContain(required);
    }
  });
});

describe('applyTheme (docs/PLAN.md §7.4)', () => {
  const root = document.documentElement;

  it('puts the Discord variables on <html> and the scheme in data-theme', () => {
    applyTheme(tokens({ scheme: 'light', vars: { '--brand-500': '#123456', '--text-default': '#222' } }));
    expect(root.dataset.theme).toBe('light');
    expect(root.style.getPropertyValue('--brand-500')).toBe('#123456');
    expect(root.style.getPropertyValue('--text-default')).toBe('#222');
  });

  it('without stored tokens the popup uses its built-in dark palette', () => {
    applyTheme(null);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.getPropertyValue('--brand-500')).toBe('');
  });

  it('a new theme replaces the old one: variables it no longer has are removed', () => {
    applyTheme(tokens({ vars: { '--brand-500': '#111', '--text-default': '#222' } }));
    applyTheme(tokens({ vars: { '--brand-500': '#333' } }));
    expect(root.style.getPropertyValue('--brand-500')).toBe('#333');
    expect(root.style.getPropertyValue('--text-default')).toBe('');
  });

  it('only sets what passes the sanitizer', () => {
    applyTheme(tokens({ vars: { '--brand-500': 'url(https://evil.example/x)', '--text-default': '#222', '--unknown': 'red' } }));
    expect(root.style.getPropertyValue('--brand-500')).toBe('');
    expect(root.style.getPropertyValue('--unknown')).toBe('');
    expect(root.style.getPropertyValue('--text-default')).toBe('#222');
  });

  it('works on any element (and tracks each one separately)', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    applyTheme(tokens({ vars: { '--brand-500': '#aaa' } }), a);
    applyTheme(tokens({ vars: {} }), b);
    expect(a.style.getPropertyValue('--brand-500')).toBe('#aaa');
    expect(b.style.getPropertyValue('--brand-500')).toBe('');
    expect(a.dataset.theme).toBe('dark');
  });
});

describe('theme.css (the tokens components use)', () => {
  it('has a fallback palette for dark and a separate one for light', () => {
    expect(css).toMatch(/:root\s*{[^}]*color-scheme:\s*dark/);
    expect(css).toMatch(/:root\[data-theme='light'\]\s*{[^}]*color-scheme:\s*light/);
    expect(css).toContain('--dce-f-bg-primary: #313338'); // Discord's dark chat background
  });

  it('every token that maps a Discord variable falls back to the built-in palette', () => {
    const mapped = [...css.matchAll(/--dce-[a-z-]+:\s*var\((--[a-z0-9-]+),\s*var\((--dce-f-[a-z-]+)\)\)/g)];
    expect(mapped.length).toBeGreaterThan(15);
    for (const [, discordVar, fallback] of mapped) {
      expect(THEME_VAR_NAMES, discordVar).toContain(discordVar);
      expect(css, fallback).toContain(`${fallback}:`);
    }
  });

  it('does not use a remote resource', () => {
    expect(css).not.toMatch(/url\(|@import/);
  });
});
