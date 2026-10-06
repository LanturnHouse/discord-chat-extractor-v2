/** The small Discord-style toast at the bottom centre of the page (docs/PLAN.md §7.1): one at a time, 2.5 s. */
import { OWN, OWN_VALUE, TIMING } from '../config';
import { createToastIcon, type ToastIconName } from '../inject/icons';
import type { Overlay } from './overlay';

export type ToastKind = ToastIconName; // 'success' | 'info' | 'error'

export class Toast {
  private el: HTMLElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private removeTimer: ReturnType<typeof setTimeout> | undefined;

  /** `onIdle` runs when the toast has faded out and left the page (the owner may then drop the overlay). */
  constructor(
    private readonly overlay: Overlay,
    private readonly onIdle: () => void = () => undefined,
  ) {}

  /** Shows `text` (replacing a toast that is still up) and hides it after 2.5 s. */
  show(kind: ToastKind, text: string): void {
    const root = this.overlay.ensureRoot();
    const doc = this.overlay.doc;
    clearTimeout(this.hideTimer);
    clearTimeout(this.removeTimer);

    let el = this.el;
    if (!el || !el.isConnected) {
      el = doc.createElement('div');
      el.className = 'dce-toast';
      el.setAttribute(OWN, OWN_VALUE.toast);
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('data-visible', 'false');
      root.appendChild(el);
      el.getBoundingClientRect(); // lay it out hidden first, so the change below fades in instead of popping up
      this.el = el;
    }
    el.setAttribute('data-kind', kind);
    const label = doc.createElement('span');
    label.textContent = text;
    el.replaceChildren(createToastIcon(doc, kind), label);
    el.setAttribute('data-visible', 'true');
    this.hideTimer = setTimeout(() => this.hide(), TIMING.toastMs);
  }

  /** Fades the toast out and removes it. */
  hide(): void {
    clearTimeout(this.hideTimer);
    const el = this.el;
    if (!el) return;
    el.setAttribute('data-visible', 'false');
    clearTimeout(this.removeTimer);
    this.removeTimer = setTimeout(() => {
      el.remove();
      if (this.el === el) this.el = null;
      this.onIdle();
    }, TIMING.toastFadeMs);
  }

  /** Immediately, without fading (teardown). */
  dispose(): void {
    clearTimeout(this.hideTimer);
    clearTimeout(this.removeTimer);
    this.el?.remove();
    this.el = null;
  }
}
