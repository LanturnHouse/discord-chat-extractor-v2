/**
 * Our own nodes that are not row buttons: the `<style id="dce-style">` and the fixed overlay root that holds the tooltip and
 * the toast. Both are created on first use and removed with `release()` (buttons switched off, or the extension went away).
 * They are appended, never mixed into Discord's React tree, and carry the `data-dce` marker so the injector ignores them.
 */
import { OWN, OWN_VALUE, ROOT_ID, STYLE_ID } from '../config';
import css from '../styles.css?inline';

export class Overlay {
  private style: HTMLStyleElement | null = null;
  private root: HTMLElement | null = null;

  constructor(readonly doc: Document) {}

  /** The `<style>` with the content script's CSS (created once, re-created if the page dropped it). */
  ensureStyle(): void {
    if (this.style?.isConnected) return;
    this.doc.getElementById(STYLE_ID)?.remove(); // a stale one of an earlier run
    const style = this.doc.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute(OWN, OWN_VALUE.style);
    style.textContent = css;
    (this.doc.head ?? this.doc.documentElement).appendChild(style);
    this.style = style;
  }

  /** The overlay root (a `position: fixed` layer on top of the page), with the style in place. */
  ensureRoot(): HTMLElement {
    this.ensureStyle();
    if (this.root?.isConnected) return this.root;
    this.doc.getElementById(ROOT_ID)?.remove();
    const root = this.doc.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute(OWN, OWN_VALUE.root);
    (this.doc.body ?? this.doc.documentElement).appendChild(root);
    this.root = root;
    return root;
  }

  /** Removes the style and the root (and with it the tooltip and the toast). */
  release(): void {
    this.root?.remove();
    this.style?.remove();
    this.root = null;
    this.style = null;
  }
}
