import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRESH_ATTR, GLYPH_ATTR, GLYPH_VALUE, STATE_ATTR } from '@/content/config';
import css from '@/content/styles.css?inline';
import { THEME_VARS } from '@/content/theme';
import { specificityOf } from './helpers/cascade';

/** The rules of the stylesheet as [selector, body] pairs (no at-rules, no nesting: the file is flat). */
function rules(text: string): [string, string][] {
  const out: [string, string][] = [];
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([match[1]!.trim().replace(/\s+/g, ' '), match[2]!.trim()]);
  return out;
}

const all = rules(css);
const bodyOf = (selector: string): string => {
  const hit = all.find(([s]) => s.split(',').map((part) => part.trim()).includes(selector));
  if (!hit) throw new Error(`no rule with selector ${selector}`);
  return hit[1];
};

describe('styles.css (the fallback look of PLAN §4 and the overlay)', () => {
  it('is the file the build inlines, and it has rules', () => {
    expect(css).toBe(readFileSync(new URL('../../src/content/styles.css', import.meta.url), 'utf8'));
    expect(all.length).toBeGreaterThan(20);
  });

  it('every row button is forced visible by our own class: block with !important, flex for a DM (PLAN §2 "버튼 표시")', () => {
    expect(bodyOf('.dce-always')).toMatch(/display:\s*block\s*!important/);
    expect(bodyOf('.dce-always[data-dce-kind="dm"]')).toMatch(/display:\s*flex\s*!important/);
  });

  it('the fallback button is always visible too: a block (a flex box for a DM), no hidden state', () => {
    expect(bodyOf('.dce-row-btn')).toMatch(/display:\s*block/);
    expect(bodyOf('.dce-row-btn[data-dce-kind="dm"]')).toMatch(/display:\s*flex/);
    for (const [selector, body] of all) {
      if (!/dce-row-btn|dce-always/.test(selector)) continue;
      expect(body, selector).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])/);
    }
  });

  it('there is no hover / focus / selection rule that SHOWS a row button any more (it is never hidden), and no per-state force rule', () => {
    for (const [selector] of all) {
      if (!/dce-row-btn|dce-always|data-dce="row-btn"|data-dce-src/.test(selector)) continue;
      // (`:hover` on the button itself is its colour; `X:hover .button` would be a show-on-hover rule)
      expect(selector, selector).not.toMatch(/iconVisibility|selected_|modeSelected_|alwaysShown_|list-item-id|:focus-within|:hover[ >+~]/);
      expect(selector, selector).not.toMatch(/data-dce-force|:has\(/);
    }
    expect(css).not.toMatch(/data-dce-force/);
  });

  it('the category button (outside children_) takes the icon colours: --interactive-icon-default, hover --interactive-icon-hover', () => {
    expect(bodyOf('.dce-row-btn[data-dce-kind="category"]')).toMatch(/color:\s*var\(--interactive-icon-default,/);
    expect(bodyOf('.dce-row-btn[data-dce-kind="category"]:hover')).toMatch(/color:\s*var\(--interactive-icon-hover,/);
    expect(bodyOf('.dce-row-btn')).toMatch(/width:\s*16px/);
    expect(bodyOf('.dce-row-btn')).toMatch(/height:\s*16px/);
  });

  it('the server button`s wrapper has margin-left:auto: it sits next to the invite button, not in the middle of space-between', () => {
    expect(bodyOf('[data-dce="guild-wrap"]')).toMatch(/margin-left:\s*auto/);
  });

  it('the server button fallback (a header without an invite button) is a 32x32 centred box in Discord`s icon colours, with a 20px svg', () => {
    const button = bodyOf('.dce-guild-btn');
    expect(button).toMatch(/display:\s*flex/);
    expect(button).toMatch(/align-items:\s*center/);
    expect(button).toMatch(/justify-content:\s*center/);
    expect(button).toMatch(/width:\s*32px/);
    expect(button).toMatch(/height:\s*32px/);
    expect(button).toMatch(/border-radius:\s*var\(--radius-sm,/);
    expect(button).toMatch(/color:\s*var\(--interactive-icon-default,/);
    expect(bodyOf('.dce-guild-btn:hover')).toMatch(/color:\s*var\(--interactive-icon-hover,/);
    expect(bodyOf('.dce-guild-btn > .dce-guild-icon')).toMatch(/width:\s*20px[^}]*height:\s*20px|height:\s*20px[^}]*width:\s*20px/);
  });

  it('the server button is always visible: no rule hides it, and no row rule (hover, selected, forced) is about it', () => {
    for (const [selector, body] of all) {
      if (!/guild/.test(selector)) continue;
      expect(body, selector).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])/);
    }
    for (const [selector] of all) {
      if (/guild/.test(selector)) expect(selector, selector).not.toMatch(/iconVisibility|selected_|modeSelected_|alwaysShown_|list-item-id|:hover \.dce|:focus-within/);
    }
  });

  it('a server button that waits for the answer is dimmed (and shows the busy cursor)', () => {
    const busy = bodyOf('[data-dce="guild-btn"][aria-busy="true"]');
    expect(busy).toMatch(/opacity:\s*0?\.\d+/);
    expect(busy).toMatch(/cursor:\s*progress/);
  });

  describe('a checked button shows a cross instead of the check mark on hover / keyboard focus (pure CSS on data-dce-state)', () => {
    const glyphRules = all.filter(([selector]) => /data-dce-glyph|data-dce-state/.test(selector));
    const REVEAL = /^\[data-dce-state="queued"\]:not\(\[data-dce-fresh\]\):(?:hover|focus-visible) \[data-dce-glyph="(?:state|remove)"\]$/;
    /** The selector of the swap for a pseudo-class and a glyph: checked, not just added by the click, pointer / focus on the button. */
    const swap = (pseudo: string, glyph: string): string => `[data-dce-state="queued"]:not([data-dce-fresh])${pseudo} [data-dce-glyph="${glyph}"]`;

    it('the cross is hidden by default', () => {
      expect(bodyOf('[data-dce-glyph="remove"]')).toMatch(/display:\s*none/);
    });

    it('while the button is checked and hovered, the state glyph goes and the cross shows; the same for :focus-visible', () => {
      for (const pseudo of [':hover', ':focus-visible']) {
        expect(bodyOf(swap(pseudo, 'state'))).toMatch(/display:\s*none/);
        expect(bodyOf(swap(pseudo, 'remove'))).toMatch(/display:\s*inline/);
      }
    });

    it('the swap does not apply to a button marked data-dce-fresh (just added by the user`s click: the check mark must be seen first)', () => {
      expect(FRESH_ATTR).toBe('data-dce-fresh');
      const swapRules = glyphRules.filter(([, body]) => /display:\s*(?:none|inline)/.test(body)).filter(([selector]) => !/^\[data-dce-glyph="remove"\]$/.test(selector));
      expect(swapRules).toHaveLength(2); // the state glyph's rule and the cross's rule
      for (const [selector] of swapRules) {
        for (const part of selector.split(',').map((one) => one.trim())) expect(part, part).toContain(`:not([${FRESH_ATTR}])`);
      }
      // and nothing else in the file reveals the cross
      expect(css.replace(/\/\*[\s\S]*?\*\//g, '').match(/data-dce-glyph="remove"/g)).toHaveLength(3); // the default + the two reveal selectors
    });

    it('every selector that mentions the glyphs or the state is one of those four: the pointer / focus is on the button itself, and only a checked one', () => {
      const selectors = glyphRules.flatMap(([selector]) => selector.split(',').map((part) => part.trim()));
      expect(selectors).toHaveLength(5); // the default hide, then (hover, focus-visible) for the state glyph and for the cross
      for (const selector of selectors) {
        if (selector === '[data-dce-glyph="remove"]') continue;
        expect(selector).toMatch(REVEAL);
      }
      // nothing for the idle state, and no show-on-hover of an ancestor (a row) that would reach the glyphs
      expect(css).not.toMatch(/data-dce-state="idle"/);
      expect(glyphRules.map(([selector]) => selector).join(' ')).not.toMatch(/dce-always|dce-row-btn|dce-guild-btn|data-dce="|:has\(|:focus-within|:hover[ >+~]\.|iconItem|closeButton/);
    });

    it('they set display and nothing else: no colour (the mirrored / native colour stays), no size, no transition, no !important', () => {
      for (const [selector, body] of glyphRules) {
        const properties = body.split(';').map((part) => part.split(':')[0]!.trim()).filter((name) => name !== '');
        expect(properties, selector).toEqual(['display']);
        expect(body, selector).not.toMatch(/!important/);
      }
    });

    it('the revealing rules out-rank the default hide (specificity), so the cross shows without !important and without source-order luck', () => {
      const [hideIds, hideClasses, hideElements] = specificityOf('[data-dce-glyph="remove"]');
      expect([hideIds, hideClasses, hideElements]).toEqual([0, 1, 0]);
      for (const pseudo of [':hover', ':focus-visible']) {
        for (const glyph of ['state', 'remove']) {
          const [ids, classes, elements] = specificityOf(swap(pseudo, glyph));
          expect(ids).toBe(0);
          expect(classes).toBe(4); // state + :not(fresh) + :hover / :focus-visible + glyph
          expect(classes).toBeGreaterThan(hideClasses);
          expect(elements).toBe(0);
        }
      }
    });

    it('the attribute names and values are the ones the script writes', () => {
      expect(css).toContain(`[${STATE_ATTR}="queued"]`);
      expect(css).toContain(`[${GLYPH_ATTR}="${GLYPH_VALUE.remove}"]`);
      expect(css).toContain(`[${GLYPH_ATTR}="${GLYPH_VALUE.state}"]`);
    });

    it('the forcing rules and the colour rules of the buttons are untouched by it (the button is still never hidden)', () => {
      expect(bodyOf('.dce-always')).toMatch(/display:\s*block\s*!important/);
      expect(bodyOf('.dce-row-btn:hover')).toMatch(/color:/);
      expect(bodyOf('.dce-guild-btn:hover')).toMatch(/color:/);
      expect(bodyOf('.dce-row-btn')).toMatch(/width:\s*16px/);
      expect(bodyOf('.dce-guild-btn > .dce-guild-icon')).toMatch(/20px/);
    });
  });

  it('the toast sits at the bottom centre, and the tooltip is fixed (positioned by script)', () => {
    const toast = bodyOf('.dce-toast');
    expect(toast).toMatch(/position:\s*fixed/);
    expect(toast).toMatch(/left:\s*50%/);
    expect(toast).toMatch(/bottom:\s*\d+px/);
    expect(bodyOf('.dce-tooltip')).toMatch(/position:\s*fixed/);
    expect(bodyOf('#dce-root')).toMatch(/pointer-events:\s*none/);
  });

  it('uses only Discord variables that exist (PLAN §4 list) or its own --dce-* ones', () => {
    const used = new Set(Array.from(css.matchAll(/var\((--[a-z0-9-]+)/g)).map((match) => match[1]!));
    expect(used.size).toBeGreaterThan(8);
    for (const name of used) {
      if (name.startsWith('--dce-')) continue;
      expect(THEME_VARS, name).toContain(name);
    }
  });

  it('every Discord var() has a fallback value (the page may not define it); our own --dce-* ones are set on the root', () => {
    for (const match of css.matchAll(/var\((--[a-z0-9-]+)\s*([,)])/g)) {
      if (match[1]!.startsWith('--dce-')) continue;
      expect(match[2], `var(${match[1]})`).toBe(',');
    }
  });

  it('respects reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
