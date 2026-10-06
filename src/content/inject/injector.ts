/**
 * Puts a button into every sidebar row (docs/PLAN.md §4) and the server button into the guild header, and keeps them there.
 *
 * One MutationObserver on `document.body` collects the element nodes Discord adds; once per animation frame the rows they
 * touch are re-checked. `ensure(row)` never trusts a marker or a memory: each pass looks at the real DOM and inserts, fixes
 * or removes OUR button only. Discord's sidebars are virtualised (rows unmount and remount while scrolling, the whole list is
 * rebuilt on a server switch) and may rebuild just the icon container of a row that stays, so a row is never "done". The same
 * pass also looks at the server header (inject/guildButton.ts): it is re-created on a server switch like the rows.
 *
 * Placement (PLAN §2 "버튼 위치"): our button is always visible and always the LAST child of the row's icon area, so the icons
 * Discord adds on hover appear to its left and it never moves (see `place`).
 *
 * Rules: never move, wrap or restyle a Discord node (only our own button is inserted / moved / removed, and its look is
 * mirrored from the native icon by class name), and never react to mutations our own nodes cause.
 */
import {
  BUTTON_SELECTOR,
  GUILD_WRAP_SELECTOR,
  KEY_ATTR,
  KIND_ATTR,
  MAX_PENDING_NODES,
  OWN,
  OWN_SELECTOR,
  SRC_ATTR,
  TIMING,
} from '../config';
import { debug } from '../debug';
import { countNamedRows, nativeIconIn, rowContainer, rowsAffectedBy, rowsWithin, type Row, type RowKind } from '../dom/rows';
import { ATTR } from '../dom/selectors';
import type { Strings } from '../i18n';
import { applyState, applyStyle, createButton, identifyButton, labelFor, planStyle } from './button';
import type { ClassCache } from './classCache';
import { FreshMarks } from './fresh';
import { GuildButtons, removeGuildButtons } from './guildButton';

export type Cancel = () => void;
/** Runs `run` soon (next animation frame, or a timer when frames do not run) and returns a canceller. */
export type Scheduler = (run: () => void) => Cancel;

export interface PassStats {
  /** Rows looked at in this pass. */
  rows: number;
  /** Rows that have our button afterwards. */
  ok: number;
  /** Rows whose icon container could not be found (Discord changed that part of the markup, or the row is not built yet). */
  noContainer: number;
  errors: number;
  /** Full scans only, and only when no row was recognised: guild list items that look like rows (`data-dnd-name`) but are not. */
  unrecognized: number;
}

export interface InjectorDeps {
  doc: Document;
  cache: ClassCache;
  isQueued(key: string): boolean;
  /** Is every channel of the category (or server) `groupId` in the list? Decides the check mark of a group button. */
  isGroupChecked(groupId: string): boolean;
  strings(): Pick<
    Strings,
    'tooltipAdd' | 'tooltipRemove' | 'tooltipCategory' | 'tooltipCategoryRemove' | 'tooltipGuild' | 'tooltipGuildRemove'
  >;
  /** The server of the address bar (`/channels/<guildId>/...`), or null outside a guild: the server button needs one. */
  guildId(): string | null;
  /** A request of the server button is in flight. */
  isGuildBusy(): boolean;
  /** A pass saw a server on the page (its channel list or its header): the owner may tell the worker (`queue/groupInfo`). */
  onGuildSeen?(): void;
  isAlive(): boolean;
  /** The extension context is gone: the owner tears everything down. */
  onDead(): void;
  /** Called after every pass that looked at rows. */
  onPass(stats: PassStats): void;
  /** Tests inject their own. */
  schedule?: Scheduler;
}

/** `requestAnimationFrame` with a timer as safety net (frames do not run in a hidden tab, and the queue must not grow). */
export function frameScheduler(win: Window): Scheduler {
  return (run) => {
    let finished = false;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => {
      finished = true;
      win.cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
    const go = (): void => {
      if (finished) return;
      cancel();
      run();
    };
    frame = win.requestAnimationFrame(go);
    timer = setTimeout(go, TIMING.flushFallbackMs);
    return cancel;
  };
}

/** Removes every button of ours from the page, row buttons and server button (stale ones of an earlier run, or all on teardown). */
export function removeOwnButtons(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(BUTTON_SELECTOR))) el.remove();
  removeGuildButtons(doc);
}

export class Injector {
  private observer: MutationObserver | null = null;
  private readonly pending = new Set<Element>();
  private fullScanRequested = false;
  private cancelFrame: Cancel | null = null;
  private running = false;
  /** The pass in progress taught the class cache something new. */
  private learned = false;
  private readonly schedule: Scheduler;
  private readonly guild: GuildButtons;
  /**
   * The "just added by this click" marks (`data-dce-fresh`, inject/fresh.ts): the owner reports clicks and the pointer leaving, the
   * passes below tell it which buttons are checked.
   */
  readonly fresh = new FreshMarks();

  constructor(private readonly deps: InjectorDeps) {
    this.schedule = deps.schedule ?? frameScheduler(deps.doc.defaultView ?? window);
    this.guild = new GuildButtons(deps.doc, {
      guildId: () => deps.guildId(),
      label: (checked) => (checked ? deps.strings().tooltipGuildRemove : deps.strings().tooltipGuild),
      checked: (guildId) => deps.isGroupChecked(guildId),
      busy: () => deps.isGuildBusy(),
      applied: (button, checked) => this.fresh.update(button, checked),
    });
  }

  get active(): boolean {
    return this.running;
  }

  /** Does the page currently show at least one of our ROW buttons? (The server button does not count: health is about the rows.) */
  hasButtons(): boolean {
    return this.deps.doc.querySelector(BUTTON_SELECTOR) !== null;
  }

  start(): void {
    const { doc } = this.deps;
    if (this.running || !doc.body) return;
    this.running = true;
    removeOwnButtons(doc); // leftovers of an earlier run
    const observer = new MutationObserver((records) => this.collect(records));
    // childList + subtree is what matters; two attributes catch a recycled row whose link changed in place.
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: [ATTR.listItemId, ATTR.href] });
    this.observer = observer;
    this.requestFullScan();
  }

  /** Disconnects and removes every button. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.pending.clear();
    this.fullScanRequested = false;
    this.guild.forget();
    this.fresh.dispose();
    removeOwnButtons(this.deps.doc);
  }

  /** Looks at every row of the page in the next frame (initial render, navigation, tab shown again). */
  requestFullScan(): void {
    if (!this.running) return;
    this.fullScanRequested = true;
    this.scheduleFlush();
  }

  /** Re-applies icon and label to every button (the queue, a group, the language or a server request changed). */
  refreshAll(): void {
    for (const button of Array.from(this.deps.doc.querySelectorAll<HTMLElement>(BUTTON_SELECTOR))) {
      const kind = button.getAttribute(KIND_ATTR) as RowKind | null;
      const key = button.getAttribute(KEY_ATTR);
      if (!kind || !key) continue;
      this.syncState(button, kind, key);
    }
    this.guild.sync();
  }

  private collect(records: MutationRecord[]): void {
    if (!this.running) return;
    for (const record of records) {
      const target = record.target;
      // Our own nodes (buttons, tooltip, toast): never react to what we do ourselves.
      if (!(target instanceof Element) || target.closest(OWN_SELECTOR)) continue;
      if (record.type === 'attributes') {
        this.pending.add(target);
        continue;
      }
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element && !node.hasAttribute(OWN)) this.pending.add(node);
      }
      for (const node of Array.from(record.removedNodes)) {
        // Discord threw our button away (it rebuilt the container's children): look at that container again. A button that
        // is attached again by now was only moved by us.
        if (node instanceof Element && (node.matches(BUTTON_SELECTOR) || node.matches(GUILD_WRAP_SELECTOR)) && !node.isConnected) {
          this.pending.add(target);
        }
      }
    }
    if (this.pending.size > MAX_PENDING_NODES) {
      this.pending.clear();
      this.fullScanRequested = true;
    }
    if (this.pending.size > 0 || this.fullScanRequested) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.cancelFrame) return;
    this.cancelFrame = this.schedule(() => {
      this.cancelFrame = null;
      this.flush();
    });
  }

  /** One pass over everything collected since the last one. Public so tests (and the owner) can run it synchronously. */
  flush(): PassStats | null {
    if (!this.running) return null;
    this.cancelFrame?.();
    this.cancelFrame = null;
    if (!this.deps.isAlive()) {
      this.deps.onDead();
      return null;
    }
    const body = this.deps.doc.body;
    const fullScan = this.fullScanRequested;
    const scopes: Element[] = fullScan ? [body] : Array.from(this.pending);
    this.fullScanRequested = false;
    this.pending.clear();

    const stats: PassStats = { rows: 0, ok: 0, noContainer: 0, errors: 0, unrecognized: 0 };
    const seen = new Set<Element>();
    const found: Row[] = [];
    for (const scope of scopes) {
      if (!scope.isConnected) continue;
      for (const row of scope === body ? rowsWithin(body) : rowsAffectedBy(scope)) {
        if (seen.has(row.link)) continue;
        seen.add(row.link);
        found.push(row);
      }
    }
    // Categories last: they copy the channel icon classes that the other rows of this very pass may just have taught us.
    const ordered = [...found.filter((row) => row.kind !== 'category'), ...found.filter((row) => row.kind === 'category')];
    let sawGuildRow = false;
    this.learned = false;
    for (const row of ordered) {
      stats.rows++;
      if (row.kind !== 'dm') sawGuildRow = true;
      try {
        if (this.ensure(row) === 'ok') stats.ok++;
        else stats.noContainer++;
      } catch {
        stats.errors++;
      }
    }
    // Something new was learned while rows already wear the fallback look (e.g. categories in an earlier pass): look again once.
    if (this.learned && this.deps.doc.querySelector(`${BUTTON_SELECTOR}[${SRC_ATTR}="fallback"]`)) this.requestFullScan();
    // The server header is looked at in every pass (one cheap tag query): it is re-created on a server switch, and its content is
    // rebuilt whenever the invite button appears or goes. A failure here must not cost the rows their pass, nor count as one.
    let sawGuildHeader = false;
    try {
      sawGuildHeader = this.guild.ensure();
    } catch (error) {
      debug('server button failed', error); // Discord's header markup is none of the rows' business
    }
    // A server is on screen (its channel list or its header): the owner tells the worker, which keeps the group lists fresh.
    if (sawGuildRow || sawGuildHeader) {
      try {
        this.deps.onGuildSeen?.();
      } catch (error) {
        debug('group info failed', error);
      }
    }
    // A page that shows channel-list items but has no row we recognise: Discord changed what the rows hang on.
    if (fullScan && stats.rows === 0) stats.unrecognized = countNamedRows(this.deps.doc);
    if (stats.rows > 0 || stats.unrecognized > 0) this.deps.onPass(stats);
    return stats;
  }

  /** Idempotent: afterwards the row has exactly one button of ours, in the right place, with the right look and state. */
  private ensure(row: Row): 'ok' | 'no-container' {
    const { doc, cache } = this.deps;
    const container = rowContainer(row);
    if (!container) return 'no-container';
    const native = nativeIconIn(row, container); // always null for a category
    if (native && cache.learn(row.kind === 'dm' ? 'dm' : 'channel', native.buttonClass, native.svgClass)) this.learned = true;
    const style = planStyle(row.kind, native, cache);

    const mine = Array.from(container.querySelectorAll<HTMLElement>(BUTTON_SELECTOR));
    let button = mine[0] ?? null;
    for (const extra of mine.slice(1)) extra.remove();
    if (button) applyStyle(doc, button, style);
    else button = createButton(doc, style);

    this.place(button, container);
    identifyButton(button, row.id, row.kind);
    this.syncState(button, row.kind, row.id);
    return 'ok';
  }

  /**
   * The LAST child of the row's icon area (`rowContainer`: `children_*` of a channel / voice / thread row, `iconsContainer_*` of
   * a DM row, the `iconVisibility_*` line of a category row, after its `children_*`), so whatever Discord adds there on hover
   * (invite, edit, close, wave, "create channel") ends up to the left of our button. Only our own button moves.
   */
  private place(button: HTMLElement, container: HTMLElement): void {
    if (button.parentElement !== container || container.lastElementChild !== button) container.appendChild(button);
  }

  private syncState(button: HTMLElement, kind: RowKind, key: string): void {
    // A category button is checked when every channel of the category is in the list; a row button when the chat is.
    const queued = kind === 'category' ? this.deps.isGroupChecked(key) : this.deps.isQueued(key);
    applyState(button, { queued, label: labelFor(kind, queued, this.deps.strings()) });
    this.fresh.update(button, queued);
  }
}
