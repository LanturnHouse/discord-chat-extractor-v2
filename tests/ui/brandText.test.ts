/**
 * Text on a brand fill is white (docs/PLAN.md §7.4, 4th change).
 *
 * The current Discord build defines no "text on brand" variable. `--control-brand-foreground` exists, but it is a LIGHT lavender
 * meant for brand-coloured text on neutral backgrounds: used on the brand fill it made the "전체 다운로드" split button and the
 * item editor's "저장" look disabled although they were enabled. These tests read the real stylesheets, resolve the `var()`
 * chains against the values measured on the live "midnight" theme, and pin that
 *  - the on-brand token is Discord's `--white` (with a #fff fallback), never the lavender or a muted token,
 *  - the brand fill is the --brand-500 family,
 *  - every control that paints a brand / danger fill declares white text itself,
 *  - an enabled control is never dimmed, while the disabled markers still lower the opacity.
 * What these tests read is the colour a rule DECLARES on the control itself. Whether the text inside it (a label span, an icon)
 * really gets that colour, or declares one of its own, is the cascade, and is pinned on the rendered markup in
 * tests/ui/brandCascade.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { FILES, allRules, contrast, declOf, resolve, rulesFor, stripComments, stylesheetProps, type Rule } from './cssCascade';

/** Measured on the live page (theme "midnight"): what the content script captures into `dce.theme`. */
const MIDNIGHT = {
  '--brand-500': 'hsl(234.935 85.556% 64.706%)',
  '--brand-530': 'hsl(234.857 66.667% 58.824%)',
  '--brand-560': 'hsl(234.72 51.44% 52.353%)',
  '--white': 'hsl(0 0% 100%)',
  // A light lavender for brand-coloured text on neutral backgrounds: NOT for text on a brand fill.
  '--control-brand-foreground': 'hsl(229.381 96.581% 77.059%)',
} as const;

// --- the tokens ---------------------------------------------------------------------------------------------------------

describe('the on-brand token (text and icons on a brand fill)', () => {
  it('is Discord\'s --white with a #fff fallback, in the stylesheet itself', () => {
    expect(declOf(':root', '--dce-on-brand')).toBe('var(--white, #fff)');
  });

  it('never refers to a "text on brand" variable Discord does not have, nor to the lavender, in any stylesheet of the popup', () => {
    for (const [name, css] of Object.entries(FILES)) {
      const text = stripComments(css);
      expect(text, name).not.toMatch(/--control-brand-foreground|--text-on-brand|--button-filled-brand/);
    }
  });

  it('resolves to white on the live midnight theme, not to the lavender', () => {
    for (const scheme of ['dark', 'light'] as const) {
      const props = { ...stylesheetProps(scheme), ...MIDNIGHT };
      expect(resolve('var(--dce-on-brand)', props), scheme).toBe('hsl(0 0% 100%)');
      expect(resolve('var(--dce-on-brand)', props), scheme).not.toBe(MIDNIGHT['--control-brand-foreground']);
    }
  });

  it('is plain white when the page never defined --white (the popup only receives the captured list), in the dark and the light palette', () => {
    for (const scheme of ['dark', 'light'] as const) {
      expect(resolve('var(--dce-on-brand)', stylesheetProps(scheme)), scheme).toBe('#fff');
      // ... also when Discord's lavender is there
      expect(resolve('var(--dce-on-brand)', { ...stylesheetProps(scheme), '--control-brand-foreground': MIDNIGHT['--control-brand-foreground'] }), scheme).toBe('#fff');
    }
  });

  it('the brand fill is the --brand-500 family: --brand-500, --brand-560 on hover (the fallback palette is the same blurple)', () => {
    expect(declOf(':root', '--dce-brand')).toMatch(/^var\(--brand-500, /);
    expect(declOf(':root', '--dce-brand-hover')).toMatch(/^var\(--brand-560, /);
    const props = { ...stylesheetProps('dark'), ...MIDNIGHT };
    expect(resolve('var(--dce-brand)', props)).toBe(MIDNIGHT['--brand-500']);
    expect(resolve('var(--dce-brand-hover)', props)).toBe(MIDNIGHT['--brand-560']);
    for (const scheme of ['dark', 'light'] as const) {
      expect(resolve('var(--dce-brand)', stylesheetProps(scheme))).toBe('#5865f2');
      expect(resolve('var(--dce-brand-hover)', stylesheetProps(scheme))).toBe('#4752c4');
    }
  });

  it('white on the brand fill is readable; the lavender would not have been', () => {
    const white = MIDNIGHT['--white'];
    expect(contrast(white, MIDNIGHT['--brand-500'])).toBeGreaterThan(3.5);
    expect(contrast(white, MIDNIGHT['--brand-560'])).toBeGreaterThan(4.5); // the hover fill
    expect(contrast(MIDNIGHT['--control-brand-foreground'], MIDNIGHT['--brand-500'])).toBeLessThan(2.5); // why it looked disabled
    expect(contrast('#fff', '#5865f2')).toBeGreaterThan(3.5); // the fallback palette
    expect(contrast('#fff', '#4752c4')).toBeGreaterThan(4.5);
  });
});

// --- every brand / danger fill says what colour its text is --------------------------------------------------------------

const FILL = /^var\(--dce-(?:brand|danger)(?:-hover|-active)?\)$/;
/** Pseudo-state variants only recolour the fill (the base rule owns the text colour); a progress fill carries no text at all. */
const fillOnly = (selector: string): boolean => /:(?:hover|active|checked)/.test(selector) || selector.startsWith('.dce-progress');

describe('every control with a brand or danger fill has white text', () => {
  const filled = (): Rule[] => allRules().filter((rule) => FILL.test(rule.decl.background ?? rule.decl['background-color'] ?? '') && !rule.selectors.every(fillOnly));

  it('declares color: var(--dce-on-brand) itself (never inherited, never a muted token)', () => {
    const rules = filled();
    expect(rules.length).toBeGreaterThanOrEqual(7);
    for (const rule of rules) expect(rule.decl.color, rule.selectors.join(', ')).toBe('var(--dce-on-brand)');
  });

  it('covers the split button (main, caret, the whole pill), the primary and danger buttons, selected segments and chips, the avatar', () => {
    const covered = new Set(filled().flatMap((rule) => rule.selectors));
    for (const selector of [
      '.dce-split',
      '.dce-split__main',
      '.dce-split__caret',
      '.dce-button--primary',
      '.dce-button--danger',
      ".dce-radio--segmented .dce-radio__option[aria-checked='true']",
      ".dce-sp__chip[aria-pressed='true']",
      '.dce-avatar--fallback',
    ]) {
      expect(covered, selector).toContain(selector);
    }
  });

  it('the checked checkbox and the toggle thumb use the same white (the check mark is drawn in currentColor)', () => {
    expect(declOf('.dce-check__box', 'color')).toBe('var(--dce-on-brand)');
    expect(declOf(".dce-check__input:checked + .dce-check__box", 'background')).toBe('var(--dce-brand)');
    expect(declOf('.dce-toggle__thumb', 'background')).toBe('var(--dce-on-brand)');
  });

  it('the text of a brand-filled button is not changed by its hover / active states either', () => {
    for (const rule of allRules()) {
      if (!rule.selectors.some((selector) => /^\.dce-(?:button--(?:primary|danger)|split)/.test(selector) && /:(?:hover|active|focus)/.test(selector))) continue;
      expect(rule.decl.color ?? 'var(--dce-on-brand)', rule.selectors.join(', ')).toBe('var(--dce-on-brand)');
    }
  });
});

// --- enabled is never dimmed; disabled still is --------------------------------------------------------------------------

const DISABLED_MARKER = /:disabled|\[aria-disabled='true'\]|\[data-unavailable\]|\[data-disabled\]/;

describe('enabled controls are not dimmed, disabled ones still look disabled', () => {
  it('only a disabled marker lowers the opacity of a button, icon button or split button', () => {
    let seen = 0;
    for (const rule of allRules()) {
      if (rule.decl.opacity === undefined) continue;
      for (const selector of rule.selectors) {
        if (!/\.dce-(?:button|icon-button|split)/.test(selector)) continue;
        seen++;
        expect(selector, `opacity: ${rule.decl.opacity}`).toMatch(DISABLED_MARKER);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it('a disabled button and the "nothing to download" split main are clearly dimmed (opacity 0.3 .. 0.6) and say not-allowed', () => {
    const dimmed = (selector: string): number => Number(declOf(selector, 'opacity'));
    for (const selector of ['.dce-button:disabled', ".dce-button[aria-disabled='true']", '.dce-split[data-unavailable] .dce-split__main']) {
      expect(dimmed(selector), selector).toBeGreaterThanOrEqual(0.3);
      expect(dimmed(selector), selector).toBeLessThanOrEqual(0.6);
    }
    expect(declOf('.dce-split[data-unavailable] .dce-split__main', 'cursor')).toBe('not-allowed');
    expect(declOf('button:disabled', 'cursor')).toBe('not-allowed');
  });

  it('the enabled primary button, split pill, main part and caret carry no opacity and no muted colour at all', () => {
    for (const selector of ['.dce-button--primary', '.dce-button--danger', '.dce-split', '.dce-split__main', '.dce-split__caret']) {
      expect(rulesFor(selector).length, selector).toBeGreaterThan(0);
      expect(declOf(selector, 'color'), selector).toBe('var(--dce-on-brand)');
      for (const rule of rulesFor(selector)) {
        expect(rule.decl.opacity, selector).toBeUndefined();
        expect(rule.decl.color ?? 'var(--dce-on-brand)', selector).toBe('var(--dce-on-brand)');
      }
    }
  });
});

// --- labels of enabled controls use normal text --------------------------------------------------------------------------

describe('labels of enabled controls are normal text, not a muted or icon grey', () => {
  const MUTED = /--dce-(?:text-muted|icon-muted|icon|icon-hover|neutral)\b/;

  // The colour of the segmented option only reaches its label because `.dce-radio--segmented .dce-radio__label` inherits it;
  // tests/ui/brandCascade.test.tsx checks that on the rendered label.
  it('unselected segmented options, count chips and the "더보기" disclosure', () => {
    for (const selector of ['.dce-radio--segmented .dce-radio__option', '.dce-sp__chip', '.dce-sp__more']) {
      expect(declOf(selector, 'color'), selector).toBe('var(--dce-text)');
    }
    for (const selector of ['.dce-radio--segmented .dce-radio__option:hover', '.dce-sp__chip:hover', '.dce-sp__more:hover']) {
      expect(declOf(selector, 'color'), selector).toBe('var(--dce-text-strong)');
    }
  });

  it('no button variant that carries text borrows a muted colour', () => {
    for (const variant of ['primary', 'secondary', 'danger', 'ghost', 'link']) {
      for (const rule of rulesFor(`.dce-button--${variant}`)) expect(rule.decl.color ?? '', variant).not.toMatch(MUTED);
    }
    for (const selector of ['.dce-radio--segmented .dce-radio__option', '.dce-sp__chip', '.dce-sp__more']) {
      expect(declOf(selector, 'color') ?? '', selector).not.toMatch(MUTED);
    }
  });
});
