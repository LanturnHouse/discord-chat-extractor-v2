/**
 * Injection health (docs/PLAN.md §3, §7.2): tells the background worker whether the buttons could be put into Discord's
 * markup, so the popup can say "Discord was updated and the buttons cannot be attached" instead of silently showing nothing.
 *
 *  - `ok: true` as soon as a pass puts (or finds) a button, then at most every 5 minutes (a heartbeat, not a flood);
 *  - `ok: false` when Discord's chat rows exist but none of them yields an icon container for more than 10 seconds (or when the
 *    guild list shows items that look like rows but none is recognised: the markup they hang on changed);
 *  - with the buttons switched off nothing can fail: a standing failure is cleared with `ok: true, reason: 'disabled'`.
 */
import type { InjectHealth } from '@/shared/types';
import { TIMING } from './config';
import type { PassStats } from './inject/injector';

export interface HealthDeps {
  send(health: InjectHealth): void;
  now(): number;
  /** Does the page show at least one of our buttons right now? */
  hasButtons(): boolean;
  /** Are Discord's chat rows (that we could decorate) on the page right now? */
  hasRows(): boolean;
}

export class HealthReporter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reason = '';
  private last: { ok: boolean; reason: string | null; at: number } | null = null;

  constructor(private readonly deps: HealthDeps) {}

  /** Feed every injector pass that looked at rows. */
  onPass(stats: PassStats): void {
    if (stats.ok > 0) {
      this.clearTimer();
      this.emit(true, null);
      return;
    }
    if (stats.noContainer === 0 && stats.errors === 0 && stats.unrecognized === 0) return;
    if (this.deps.hasButtons()) return; // other rows work: nothing to report
    if (stats.noContainer > 0) this.reason = `no-icon-container (${stats.noContainer} of ${stats.rows} rows)`;
    else if (stats.errors > 0) this.reason = `inject-error (${stats.errors} of ${stats.rows} rows)`;
    else this.reason = `unrecognized-rows (${stats.unrecognized} list items, none a known row)`;
    if (this.timer === undefined) this.timer = setTimeout(() => this.check(), TIMING.healthFailMs);
  }

  /** The buttons were switched off (or the script was torn down): a standing failure no longer applies. */
  onStopped(): void {
    this.clearTimer();
    if (this.last && !this.last.ok) this.emit(true, 'disabled');
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 10 s after rows were first seen without any usable container: still nothing, still rows -> report the failure. */
  private check(): void {
    this.timer = undefined;
    if (this.deps.hasButtons() || !this.deps.hasRows()) return;
    this.emit(false, this.reason);
  }

  private emit(ok: boolean, reason: string | null): void {
    const now = this.deps.now();
    const last = this.last;
    // The same state for the same cause is not news, whatever the row counts in the reason say now.
    if (last && last.ok === ok && causeOf(last.reason) === causeOf(reason) && now - last.at < TIMING.healthRepeatMs) return;
    this.last = { ok, reason, at: now };
    this.deps.send({ ok, reason, checkedAt: now });
  }
}

/** `no-icon-container (2 of 5 rows)` -> `no-icon-container`. */
function causeOf(reason: string | null): string | null {
  return reason === null ? null : reason.split(' (')[0]!;
}
