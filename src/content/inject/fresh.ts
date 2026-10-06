/**
 * The "just added" mark of our buttons. A checked button shows a cross instead of the check mark while the pointer is on it
 * (styles.css), so that a click is known to take it out of the list. Right after the click that ADDED it, though, the pointer is
 * still on the button, and the cross would replace the check mark before anybody saw it. So a button that becomes checked as the
 * result of the user's own click carries `FRESH_ATTR` (`data-dce-fresh`), and the stylesheet does not swap while it is there.
 *
 * The mark goes when the pointer leaves the button or it loses focus (the interaction layer calls `release`), when the button
 * is unchecked, and after `TIMING.freshMs` in any case (a missed `mouseleave` must not leave it stuck). It touches nothing but
 * our own button, and the click handler is not involved: a click on a fresh button still removes the item.
 *
 * Which clicks count: `expect(key)` when a click starts a request for the button with that key (the row / category / server id,
 * `KEY_ATTR`), `settle(key)` when the request is answered. From the click until a short while after the answer, a button of that
 * key that turns checked (from the answer, or from the storage events that may even come first) is the click's result. A state
 * that arrives without a click (another tab, the popup, the shortcut) never marks anything.
 */
import { FRESH_ATTR, KEY_ATTR, TIMING } from '../config';

type Timer = ReturnType<typeof setTimeout>;

export class FreshMarks {
  /** Keys whose click is in flight (or was answered a moment ago), each with the timer that ends it. */
  private readonly awaiting = new Map<string, Timer>();
  /** Buttons that carry the mark, each with the timer that removes it. */
  private readonly marks = new Map<HTMLElement, Timer>();

  /** A click (or Enter / Space) on the button with this key starts a request. */
  expect(key: string): void {
    this.forget(key);
    this.awaiting.set(key, setTimeout(() => this.awaiting.delete(key), TIMING.freshAwaitMs));
  }

  /** The request of that click was answered (or failed): the state it caused may still arrive from the storage, but not for long. */
  settle(key: string): void {
    const timer = this.awaiting.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.awaiting.set(key, setTimeout(() => this.awaiting.delete(key), TIMING.freshGraceMs));
  }

  /**
   * The button was brought to the state `checked` (every pass and every refresh calls this, so it is idempotent): a button that
   * is checked now and whose click is awaited gets the mark, once; an unchecked button has none.
   */
  update(button: HTMLElement, checked: boolean): void {
    if (!checked) {
      this.clear(button);
      return;
    }
    if (this.marks.has(button)) return;
    const key = button.getAttribute(KEY_ATTR);
    if (key === null || !this.awaiting.has(key)) return;
    button.setAttribute(FRESH_ATTR, '');
    this.marks.set(button, setTimeout(() => this.release(button), TIMING.freshMs)); // the click is over, the next pass must not mark again
  }

  /**
   * The pointer left the button, or it lost focus: the mark goes, and a click that is still in flight no longer marks its result
   * (the user is not looking at the button any more, so nothing has to be kept from the cross).
   */
  release(button: HTMLElement): void {
    this.clear(button);
    const key = button.getAttribute(KEY_ATTR);
    if (key !== null) this.forget(key);
  }

  /** Drops every mark and every awaited click (the buttons are being removed, or switched off). */
  dispose(): void {
    for (const timer of this.awaiting.values()) clearTimeout(timer);
    this.awaiting.clear();
    for (const [button, timer] of Array.from(this.marks)) {
      clearTimeout(timer);
      if (button.hasAttribute(FRESH_ATTR)) button.removeAttribute(FRESH_ATTR);
    }
    this.marks.clear();
  }

  private clear(button: HTMLElement): void {
    const timer = this.marks.get(button);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.marks.delete(button);
    }
    if (button.hasAttribute(FRESH_ATTR)) button.removeAttribute(FRESH_ATTR);
  }

  private forget(key: string): void {
    const timer = this.awaiting.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.awaiting.delete(key);
  }
}
