import { describe, expect, it } from 'vitest';
import popupCss from '@/popup/popup.css?raw';
import { declOf, resolve, stylesheetProps } from '../ui/cssCascade';

/*
 * The layout rules of the queue tree (docs/PLAN.md §7.2a) that a jsdom test cannot measure: the stylesheet is read as text.
 * Long names are cut with an ellipsis instead of widening the 380px popup, a level is 16px, the guide line is the subtle border
 * colour, and nothing is laid out with a combinator or nesting that the other stylesheet readers of this repo cannot parse.
 */

const truncates = (selector: string): void => {
  expect(declOf(selector, 'overflow'), `${selector} overflow`).toBe('hidden');
  expect(declOf(selector, 'text-overflow'), `${selector} text-overflow`).toBe('ellipsis');
  expect(declOf(selector, 'min-width'), `${selector} min-width`).toBe('0');
};

describe('long names never widen the popup', () => {
  it('the name of a group, the channel names of its subtitle, the label of a row and the parts of a one-line row are cut with an ellipsis', () => {
    truncates('.dce-group__name');
    truncates('.dce-group__subtitle');
    truncates('.dce-row__name');
    truncates('.dce-row__crumb-name');
    expect(declOf('.dce-group__name', 'white-space')).toBe('nowrap');
    expect(declOf('.dce-group__subtitle', 'white-space')).toBe('nowrap');
    expect(declOf('.dce-row__label', 'white-space')).toBe('nowrap');
    expect(declOf('.dce-row__label', 'overflow')).toBe('hidden');
    expect(declOf('.dce-row__label', 'min-width')).toBe('0');
  });

  it('the flex parents of those texts can shrink (min-width: 0), the count chip and the badges cannot', () => {
    for (const selector of ['.dce-group__main', '.dce-group__body', '.dce-group__title', '.dce-group__meta', '.dce-row__main']) {
      expect(declOf(selector, 'min-width'), selector).toBe('0');
    }
    expect(declOf('.dce-chip', 'flex')).toBe('none');
    expect(declOf('.dce-chip', 'white-space')).toBe('nowrap');
  });

  it('the badges of a group line (settings, "개별 N", "미완료 N") wrap onto a second line instead of being cut off', () => {
    expect(declOf('.dce-group__meta', 'flex-wrap')).toBe('wrap');
  });

  it('in a one-line row the server (or category) gives way before the channel name does', () => {
    // (the crumb shrinks nine times as fast as the name; a percentage max-width would be taken from a label that is only as wide as its text)
    expect(declOf('.dce-row__crumb', 'flex')).toBe('0 9 auto');
    expect(declOf('.dce-row__crumb', 'max-width')).toBeUndefined();
    expect(declOf('.dce-row__name', 'flex')).toBe('0 1 auto');
    expect(declOf('.dce-row__crumb-sep', 'flex')).toBe('none');
  });
});

describe('indentation and the guide line', () => {
  it('a level is 16px: rows and group lines pad their left side by 12px + depth x 16px', () => {
    expect(declOf('.dce-row', 'padding')).toBe('8px 8px 8px calc(12px + var(--dce-depth, 0) * 16px)');
    expect(declOf('.dce-group', 'padding')).toBe('6px 8px 6px calc(12px + var(--dce-depth, 0) * 16px)');
  });

  it('the nested list of an open group draws a 1px vertical line in the subtle border colour, under the chevron of its group line', () => {
    expect(declOf('.dce-children', 'position')).toBe('relative');
    expect(declOf('.dce-children::before', 'width')).toBe('1px');
    expect(declOf('.dce-children::before', 'top')).toBe('0');
    expect(declOf('.dce-children::before', 'bottom')).toBe('0');
    expect(declOf('.dce-children::before', 'background')).toBe('var(--dce-border)');
    // 12px (the padding) + (depth - 1) x 16px + 8px (the middle of the 16px chevron)
    expect(declOf('.dce-children::before', 'left')).toBe('calc(12px + (var(--dce-depth, 1) - 1) * 16px + 8px)');
    expect(declOf('.dce-children::before', 'pointer-events')).toBe('none');
    // --dce-border is Discord's --border-subtle (with a fallback palette)
    for (const scheme of ['dark', 'light'] as const) {
      expect(declOf(':root', '--dce-border')).toBe('var(--border-subtle, var(--dce-f-border))');
      expect(resolve('var(--dce-border)', { ...stylesheetProps(scheme), '--border-subtle': 'hsl(0 0% 50%)' })).toBe('hsl(0 0% 50%)');
    }
  });

  it('the chevron is the same size as the space the guide line counts on (16px) and turns when the group is open', () => {
    expect(declOf('.dce-group__chevron', 'width')).toBe('16px');
    expect(declOf('.dce-group__chevron', 'height')).toBe('16px');
    expect(declOf(".dce-group__main[aria-expanded='true'] .dce-group__chevron", 'transform')).toBe('rotate(90deg)');
  });

  it('the group line highlights on hover and on keyboard focus inside it, like a row', () => {
    expect(declOf('.dce-group:hover', 'background')).toBe('var(--dce-bg-hover)');
    expect(declOf('.dce-group:focus-within', 'background')).toBe('var(--dce-bg-hover)');
    expect(declOf('.dce-group__main:focus-visible', 'outline-offset')).toBe('-2px');
  });
});

describe('the server icon', () => {
  it('is a 20px circle; without a picture it is the first letter in white on the brand fill', () => {
    expect(declOf('.dce-server-icon', 'width')).toBe('20px');
    expect(declOf('.dce-server-icon', 'height')).toBe('20px');
    expect(declOf('.dce-server-icon', 'border-radius')).toBe('50%');
    expect(declOf('.dce-server-icon--fallback', 'background')).toBe('var(--dce-brand)');
    expect(declOf('.dce-server-icon--fallback', 'color')).toBe('var(--dce-on-brand)');
  });
});

describe('the "서버 설정" / "카테고리 설정" badge has a tone of its own', () => {
  it('between the grey of the common settings and the brand colour of "개별 설정"', () => {
    expect(declOf('.dce-badge--info', 'background')).toContain('var(--dce-link)');
    expect(declOf('.dce-badge--info', 'color')).toBe('var(--dce-text-strong)');
    expect(declOf('.dce-badge--brand', 'background')).toContain('var(--dce-brand)');
  });
});

describe('motion', () => {
  it('the chevron animates, and not for people who asked for less motion', () => {
    expect(declOf('.dce-group__chevron', 'transition')).toContain('transform');
    expect(popupCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.dce-group__chevron\s*\{\s*transition:\s*none/);
  });
});
