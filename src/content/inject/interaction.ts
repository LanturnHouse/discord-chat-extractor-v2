/**
 * Mouse, keyboard and hover handling for our buttons (the row buttons and the server button of the guild header), as ONE set
 * of capture-phase listeners on the window (docs/PLAN.md §7.1). Capturing at the window means Discord's own handlers (row
 * link navigation, drag and drop, the close button of a group DM that would open "Leave Group", the server menu next to the
 * server button) never see an event that starts on our button: it is stopped before it can reach them, whichever phase they
 * listen in. Nothing is attached to Discord's elements.
 */
import { CLICKABLE_SELECTOR } from '../config';

export interface InteractionDeps {
  win: Window;
  isAlive(): boolean;
  /** The extension context is gone: the owner tears everything down. */
  onDead(): void;
  /** Click / Enter / Space on a button (a row button or the server button: the owner tells them apart). */
  activate(button: HTMLElement): void;
  showTooltip(button: HTMLElement): void;
  /** Hide the tooltip (only when it belongs to `button`, if given). */
  hideTooltip(button?: HTMLElement): void;
  /** The pointer left the button, or it lost focus (the "just added" mark of a checked button ends, inject/fresh.ts). */
  leave(button: HTMLElement): void;
}

/** Pointer and mouse events that must never reach Discord when they start on our button. */
const POINTER_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'] as const;

/** Our button (row button or server button) an event target is (or is inside), else null. */
export function ownButtonOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest(CLICKABLE_SELECTOR);
  return button instanceof HTMLElement ? button : null;
}

function block(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Installs the listeners; the returned function removes them. */
export function installInteraction(deps: InteractionDeps): () => void {
  const { win } = deps;
  /** A press started on our button: a native drag of the row around it must not begin. */
  let pressed = false;

  const onPointer = (event: Event): void => {
    const button = ownButtonOf(event.target);
    if (!button) {
      if (event.type === 'pointerup' || event.type === 'mouseup') pressed = false;
      return;
    }
    if (event.type === 'pointerdown' || event.type === 'mousedown') pressed = true;
    else if (event.type === 'pointerup' || event.type === 'mouseup') pressed = false;
    block(event);
    if (!deps.isAlive()) return deps.onDead(); // an orphaned button of a reloaded extension: swallow the click, then clean up
    if (event.type === 'click') deps.activate(button);
  };

  // The row (or its link) is the element Discord makes draggable, so the drag starts on THEM, not on our button: a press that
  // began on our button is what we recognise it by.
  const onDragStart = (event: Event): void => {
    if (!pressed && !ownButtonOf(event.target)) return;
    block(event);
    if (!deps.isAlive()) deps.onDead();
  };
  const onPressEnd = (): void => {
    pressed = false;
  };

  const onKey = (event: Event): void => {
    const key = event as KeyboardEvent;
    const button = ownButtonOf(event.target);
    if (!button) return;
    if (key.key !== 'Enter' && key.key !== ' ' && key.key !== 'Spacebar') return;
    block(event);
    if (!deps.isAlive()) return deps.onDead();
    if (event.type === 'keydown' && !key.repeat) deps.activate(button);
  };

  const onOver = (event: Event): void => {
    const button = ownButtonOf(event.target);
    if (!button) return;
    const from = (event as MouseEvent).relatedTarget;
    if (from instanceof Node && button.contains(from)) return;
    deps.showTooltip(button);
  };
  /**
   * The pointer went from our button (or something inside it) to somewhere outside it: the button, else null. Moving between the
   * button's own children, or onto it from one of them, is not leaving. `relatedTarget` is null when the pointer left the window.
   */
  const leftButton = (event: Event): HTMLElement | null => {
    const button = ownButtonOf(event.target);
    if (!button) return null;
    const to = (event as MouseEvent).relatedTarget;
    return to instanceof Node && button.contains(to) ? null : button;
  };
  const onOut = (event: Event): void => {
    const button = leftButton(event);
    if (!button) return;
    deps.hideTooltip(button);
    deps.leave(button);
  };
  // Chrome delivers `mouseleave` / `pointerleave` (which do not bubble) to nobody but the element itself, never to a window-level
  // capture listener, so the out events do the job. `pointerout` comes with `mouseout`; either one is enough, both are harmless.
  const onPointerOut = (event: Event): void => {
    const button = leftButton(event);
    if (button) deps.leave(button);
  };
  const onFocusIn = (event: Event): void => {
    const button = ownButtonOf(event.target);
    if (button) deps.showTooltip(button);
  };
  const onFocusOut = (event: Event): void => {
    const button = ownButtonOf(event.target);
    if (!button) return;
    deps.hideTooltip(button);
    deps.leave(button);
  };
  // The sidebar scrolls under a pointer that stays put; the tooltip is fixed to the viewport, so it goes away.
  const onScroll = (): void => deps.hideTooltip();

  const capture = { capture: true } as const;
  for (const type of POINTER_EVENTS) win.addEventListener(type, onPointer, capture);
  win.addEventListener('dragstart', onDragStart, capture);
  win.addEventListener('dragend', onPressEnd, capture);
  win.addEventListener('pointercancel', onPressEnd, capture);
  win.addEventListener('keydown', onKey, capture);
  win.addEventListener('keyup', onKey, capture);
  win.addEventListener('mouseover', onOver, capture);
  win.addEventListener('mouseout', onOut, capture);
  win.addEventListener('pointerout', onPointerOut, capture);
  win.addEventListener('focusin', onFocusIn, capture);
  win.addEventListener('focusout', onFocusOut, capture);
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return () => {
    for (const type of POINTER_EVENTS) win.removeEventListener(type, onPointer, capture);
    win.removeEventListener('dragstart', onDragStart, capture);
    win.removeEventListener('dragend', onPressEnd, capture);
    win.removeEventListener('pointercancel', onPressEnd, capture);
    win.removeEventListener('keydown', onKey, capture);
    win.removeEventListener('keyup', onKey, capture);
    win.removeEventListener('mouseover', onOver, capture);
    win.removeEventListener('mouseout', onOut, capture);
    win.removeEventListener('pointerout', onPointerOut, capture);
    win.removeEventListener('focusin', onFocusIn, capture);
    win.removeEventListener('focusout', onFocusOut, capture);
    win.removeEventListener('scroll', onScroll, { capture: true });
  };
}
