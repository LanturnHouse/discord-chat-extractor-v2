/** The Discord-style speech bubble above a row button, on hover and keyboard focus (docs/PLAN.md §7.1). One element, reused. */
import { OWN, OWN_VALUE } from '../config';
import type { Overlay } from './overlay';

const GAP = 8;
const EDGE = 4;

export class Tooltip {
  private el: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;

  /** `labelOf` gives the text for a button (its current state), so a state change shows up while the bubble is open. */
  constructor(
    private readonly overlay: Overlay,
    private readonly labelOf: (button: HTMLElement) => string,
  ) {}

  get anchoredTo(): HTMLElement | null {
    return this.anchor;
  }

  show(button: HTMLElement): void {
    const text = this.labelOf(button);
    if (!text) return;
    const root = this.overlay.ensureRoot();
    let el = this.el;
    if (!el || !el.isConnected) {
      el = this.overlay.doc.createElement('div');
      el.className = 'dce-tooltip';
      el.setAttribute(OWN, OWN_VALUE.tooltip);
      el.setAttribute('role', 'tooltip');
      el.setAttribute('data-visible', 'false');
      root.appendChild(el);
      el.getBoundingClientRect(); // lay it out hidden first, so the change below fades in
      this.el = el;
    }
    this.anchor = button;
    el.textContent = text;
    el.setAttribute('data-visible', 'true');
    this.position();
  }

  /** Hides the bubble; with a `button`, only when the bubble belongs to that button. */
  hide(button?: HTMLElement): void {
    if (button && this.anchor !== button) return;
    this.anchor = null;
    this.el?.setAttribute('data-visible', 'false');
  }

  /** Re-reads the text of the anchored button (its state changed) and re-places the bubble; hides it if the button is gone. */
  refresh(): void {
    const anchor = this.anchor;
    if (!anchor) return;
    if (!anchor.isConnected) {
      this.hide();
      return;
    }
    const text = this.labelOf(anchor);
    if (this.el && this.el.textContent !== text) this.el.textContent = text;
    this.position();
  }

  /** Above the button, centred, kept inside the window; below it when there is no room above. The arrow points at the button. */
  private position(): void {
    const { el, anchor } = this;
    if (!el || !anchor) return;
    const view = this.overlay.doc.defaultView;
    if (!view) return;
    const a = anchor.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const centre = a.left + a.width / 2;
    const left = Math.max(EDGE, Math.min(centre - t.width / 2, view.innerWidth - t.width - EDGE));
    let top = a.top - t.height - GAP;
    let placement = 'top';
    if (top < EDGE) {
      top = a.bottom + GAP;
      placement = 'bottom';
    }
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    el.style.setProperty('--dce-arrow-x', `${Math.round(centre - left)}px`);
    el.setAttribute('data-placement', placement);
  }

  dispose(): void {
    this.anchor = null;
    this.el?.remove();
    this.el = null;
  }
}
