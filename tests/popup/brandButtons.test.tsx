// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { chainOf, effectiveColor, effectiveFill, resolve, stylesheetProps } from '../ui/cssCascade';
import { button, chatRows, renderPopup, settle } from './helpers';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

/**
 * The brand-filled buttons of the popup (docs/PLAN.md §7.4, 4th change): their text is white (tests/ui/brandText.test.ts reads
 * the stylesheets). What this file pins is the other half of "does not look disabled": an enabled button never carries a
 * disabled marker, because that is what the dimmed style keys on.
 */
describe('"⤓ 전체 다운로드" (the split button of the footer)', () => {
  it('with items in the list it is enabled: no "unavailable" marker, no aria-disabled, no title that says why not', async () => {
    await renderPopup();
    const main = button(/전체 다운로드/);
    const pill = main.closest('.dce-split');
    expect(pill).not.toBeNull();
    expect(pill!.hasAttribute('data-unavailable')).toBe(false);
    expect(main.hasAttribute('aria-disabled')).toBe(false);
    expect(main.hasAttribute('title')).toBe(false);
    expect(main.querySelector('.dce-split__chip')?.textContent).toBe('HTML');
    expect(button('공통 설정 열기').hasAttribute('aria-disabled')).toBe(false);
  });

  it('with an empty list only the main part is dimmed (unavailable + aria-disabled + a reason); the caret stays enabled', async () => {
    await renderPopup({ scenario: 'empty' });
    const main = button(/전체 다운로드/);
    expect(main.closest('.dce-split')!.hasAttribute('data-unavailable')).toBe(true);
    expect(main.getAttribute('aria-disabled')).toBe('true');
    expect(main.hasAttribute('title')).toBe(true);
    expect(button('공통 설정 열기').hasAttribute('aria-disabled')).toBe(false);
  });

  it('the state follows the list: after the last item is removed the main part is dimmed', async () => {
    await renderPopup();
    expect(button(/전체 다운로드/).closest('.dce-split')!.hasAttribute('data-unavailable')).toBe(false);
    const count = chatRows().length;
    for (let index = 0; index < count; index++) {
      fireEvent.click(within(chatRows()[0]).getByRole('button', { name: /목록에서 빼기/ }));
      await settle();
    }
    expect(button(/전체 다운로드/).closest('.dce-split')!.hasAttribute('data-unavailable')).toBe(true);
  });
});

describe('the other primary (brand) buttons', () => {
  it('[저장] of the item editor: a primary button, enabled while the values are valid, disabled (with a reason) otherwise', async () => {
    await renderPopup();
    fireEvent.click(screen.getByRole('button', { name: 'Sample Server > #general 설정' }));
    await settle();
    const save = button('저장') as HTMLButtonElement;
    expect(save.className).toContain('dce-button--primary');
    expect(save.disabled).toBe(false);
    expect(save.hasAttribute('aria-disabled')).toBe(false);
    expect(save.hasAttribute('title')).toBe(false);
    fireEvent.change(screen.getByRole('spinbutton', { name: '내보낼 메시지 개수' }), { target: { value: '0' } });
    expect((button('저장') as HTMLButtonElement).disabled).toBe(true);
    expect(button('저장').getAttribute('title')).toBe('올바르지 않은 값이 있어요');
  });

  it('[동의하고 시작] of the first-run notice: a primary button, enabled', async () => {
    await renderPopup({ scenario: 'consent' });
    const accept = button('동의하고 시작') as HTMLButtonElement;
    expect(accept.className).toContain('dce-button--primary');
    expect(accept.disabled).toBe(false);
    expect(accept.hasAttribute('aria-disabled')).toBe(false);
  });
});

/**
 * The real screens, scanned element by element: whatever text or icon sits on a brand / danger fill renders in white, whichever
 * element inside the control it is (the cascade of tests/ui/cssCascade.ts: specificity, inheritance, var() against the palette).
 */
describe('every text and icon painted on a brand fill is white, on the real screens', () => {
  const FILL = /^var\(--dce-(?:brand|danger)(?:-hover|-active)?\)$/;
  const WHITE = { fallbackDark: stylesheetProps('dark'), fallbackLight: stylesheetProps('light'), midnight: { ...stylesheetProps('dark'), '--white': 'hsl(0 0% 100%)', '--control-brand-foreground': 'hsl(229.381 96.581% 77.059%)' } };

  /** Returns how many elements were checked. */
  function expectWhiteTextOnFills(): number {
    const root = document.body;
    let checked = 0;
    for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const hasText = element.tagName.toLowerCase() === 'svg' || Array.from(element.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '');
      if (!hasText) continue;
      const chain = chainOf(element, root);
      const fill = effectiveFill(chain);
      if (fill === undefined || !FILL.test(fill)) continue;
      checked++;
      for (const [name, props] of Object.entries(WHITE)) {
        const colour = effectiveColor(chain, props);
        const expected = resolve('var(--dce-on-brand)', props);
        expect(colour, `${name}: <${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> ${(element.textContent ?? '').trim().slice(0, 20)}`).toBe(expected);
      }
    }
    return checked;
  }

  it('the list screen: the "전체 다운로드" split button (label, chip, caret) and the filled parts of the rows', async () => {
    await renderPopup();
    expect(expectWhiteTextOnFills()).toBeGreaterThanOrEqual(4);
  });

  it('the item editor (segmented controls, count chips, 저장)', async () => {
    await renderPopup();
    fireEvent.click(screen.getByRole('button', { name: 'Sample Server > #general 설정' }));
    await settle();
    expect(expectWhiteTextOnFills()).toBeGreaterThanOrEqual(3);
  });

  it('the common settings opened from the caret', async () => {
    await renderPopup();
    fireEvent.click(button('공통 설정 열기'));
    await settle();
    expect(expectWhiteTextOnFills()).toBeGreaterThanOrEqual(2);
  });

  it('the queue tree: the lettered circles of servers without an icon are white on the brand fill too', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const letters = Array.from(document.querySelectorAll('.dce-server-icon--fallback'));
    expect(letters.length).toBeGreaterThanOrEqual(2); // "Study Group" and the one-line "Book Club"
    expect(expectWhiteTextOnFills()).toBeGreaterThanOrEqual(4 + letters.length - 1);
  });

  it('the settings screen of a server (segmented controls, count chips, 저장)', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Sample Server 설정' }));
    await settle();
    expect(expectWhiteTextOnFills()).toBeGreaterThanOrEqual(3);
  });

  it('the first-run notice (동의하고 시작)', async () => {
    await renderPopup({ scenario: 'consent' });
    expect(expectWhiteTextOnFills()).toBeGreaterThanOrEqual(1);
  });
});
