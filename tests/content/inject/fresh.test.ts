// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRESH_ATTR, TIMING } from '@/content/config';
import { FreshMarks } from '@/content/inject/fresh';

let marks: FreshMarks;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  marks = new FreshMarks();
});

afterEach(() => {
  marks.dispose();
  vi.useRealTimers();
});

function button(key: string | null = 'k1'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-dce', 'row-btn');
  if (key !== null) el.setAttribute('data-dce-key', key);
  document.body.appendChild(el);
  return el;
}

const fresh = (el: Element): boolean => el.hasAttribute(FRESH_ATTR);

describe('which buttons get the mark', () => {
  it('a button that turns checked while its click is awaited is marked', () => {
    const b = button();
    marks.expect('k1');
    marks.update(b, false);
    expect(fresh(b)).toBe(false);
    marks.update(b, true);
    expect(fresh(b)).toBe(true);
  });

  it('a state nobody clicked for (another tab, the popup, a storage sync, the shortcut) is never marked', () => {
    const b = button();
    marks.update(b, true);
    expect(fresh(b)).toBe(false);
    marks.expect('some-other-key'); // another button`s click does not count for this one
    marks.update(b, true);
    expect(fresh(b)).toBe(false);
  });

  it('a button without a key is never marked', () => {
    const b = button(null);
    marks.expect('k1');
    marks.update(b, true);
    expect(fresh(b)).toBe(false);
  });

  it('only the button of the clicked key is marked, not its neighbours', () => {
    const [a, b] = [button('k1'), button('k2')];
    marks.expect('k1');
    marks.update(a, true);
    marks.update(b, true);
    expect([fresh(a), fresh(b)]).toEqual([true, false]);
  });

  it('writes the attribute on the button only, and nothing else in the page changes', () => {
    const b = button();
    const before = document.body.innerHTML.replace(` ${FRESH_ATTR}=""`, '');
    marks.expect('k1');
    marks.update(b, true);
    expect(b.getAttribute(FRESH_ATTR)).toBe('');
    expect(document.body.innerHTML.replace(` ${FRESH_ATTR}=""`, '')).toBe(before);
    expect(document.querySelectorAll(`[${FRESH_ATTR}]`)).toHaveLength(1);
  });

  it('is idempotent: every pass calls `update`, and the 8 s do not restart', () => {
    const b = button();
    marks.expect('k1');
    marks.update(b, true);
    vi.advanceTimersByTime(TIMING.freshMs - 1000);
    marks.update(b, true);
    marks.update(b, true);
    vi.advanceTimersByTime(1000);
    expect(fresh(b)).toBe(false); // the first mark ran out on time
  });

  it('the state may arrive BEFORE the answer (the worker writes the storage first): still marked, and still after the answer', () => {
    const b = button();
    marks.expect('k1');
    vi.advanceTimersByTime(2000); // the request takes a while
    marks.update(b, true); // storage event
    expect(fresh(b)).toBe(true);
    marks.settle('k1'); // answer
    marks.update(b, true);
    expect(fresh(b)).toBe(true);
  });
});

describe('when the mark goes', () => {
  it('when the button is unchecked (the click that removes it)', () => {
    const b = button();
    marks.expect('k1');
    marks.update(b, true);
    marks.expect('k1'); // clicked again while fresh: removes it
    marks.update(b, false);
    expect(fresh(b)).toBe(false);
  });

  it('when the pointer leaves or the button loses focus (`release`)', () => {
    const b = button();
    marks.expect('k1');
    marks.update(b, true);
    marks.release(b);
    expect(fresh(b)).toBe(false);
    marks.update(b, true); // the pass after it: stays unmarked, the click is over
    expect(fresh(b)).toBe(false);
  });

  it('`release` before the answer: the user is no longer looking, so the result is not marked', () => {
    const b = button();
    marks.expect('k1');
    marks.release(b);
    marks.update(b, true);
    expect(fresh(b)).toBe(false);
  });

  it('after 8 s whatever happened (a missed mouseleave must not leave it stuck)', () => {
    const b = button();
    marks.expect('k1');
    marks.update(b, true);
    vi.advanceTimersByTime(TIMING.freshMs - 1);
    expect(fresh(b)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fresh(b)).toBe(false);
    marks.update(b, true); // the next pass does not bring it back
    expect(fresh(b)).toBe(false);
  });

  it('a button the page took away leaves no timer that does harm', () => {
    const b = button();
    marks.expect('k1');
    marks.update(b, true);
    b.remove();
    expect(() => vi.advanceTimersByTime(TIMING.freshMs + 1)).not.toThrow();
    expect(fresh(b)).toBe(false);
  });

  it('`dispose` (the buttons are switched off) drops every mark and every awaited click', () => {
    const [a, b] = [button('k1'), button('k2')];
    marks.expect('k1');
    marks.expect('k2');
    marks.update(a, true);
    marks.dispose();
    expect(fresh(a)).toBe(false);
    marks.update(b, true);
    expect(fresh(b)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('how long a click counts', () => {
  it('from the click until a short grace after the answer, then a state that turns up is not that click`s', () => {
    const b = button();
    marks.expect('k1');
    marks.settle('k1');
    vi.advanceTimersByTime(TIMING.freshGraceMs - 1);
    marks.update(b, true); // storage confirmation within the grace: marked
    expect(fresh(b)).toBe(true);

    const c = button('k3');
    marks.expect('k3');
    marks.settle('k3');
    vi.advanceTimersByTime(TIMING.freshGraceMs);
    marks.update(c, true); // too late: some other event
    expect(fresh(c)).toBe(false);
  });

  it('an answer that fails (nothing changed) ends the wait after the grace: a later change from elsewhere is not marked', () => {
    const b = button();
    marks.expect('k1');
    marks.settle('k1');
    vi.advanceTimersByTime(TIMING.freshGraceMs + 1);
    marks.update(b, true);
    expect(fresh(b)).toBe(false);
  });

  it('a request that never reports back stops counting after 30 s', () => {
    const b = button();
    marks.expect('k1');
    vi.advanceTimersByTime(TIMING.freshAwaitMs - 1);
    marks.update(b, true);
    expect(fresh(b)).toBe(true);
    marks.release(b);
    marks.expect('k1');
    vi.advanceTimersByTime(TIMING.freshAwaitMs);
    marks.update(b, true);
    expect(fresh(b)).toBe(false);
  });

  it('`settle` of a click nobody registered (or already over) does nothing', () => {
    expect(() => marks.settle('nobody')).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
