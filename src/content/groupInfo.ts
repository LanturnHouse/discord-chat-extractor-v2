/**
 * Tells the background worker which servers the page shows (`queue/groupInfo`, docs/PLAN.md §2 "추가 UX 규칙", §3 "그룹 정보"), so
 * it can keep `LOCAL.groups(account)` (the channels of every category and of the server, as far as the account may read them)
 * fresh: the check marks of the category and server buttons are computed from it.
 *
 * Throttled per page: a server is reported at most once every 5 minutes, except that
 *  - a server reported while no account was known (so the worker could not answer) is reported again as soon as one is, and
 *  - a server the worker answered `no-account` is reported again after a short while (a few times at most), because the account
 *    the worker confirms later is often the one the page already had: no storage event says so, and without this the group lists
 *    (and with them every check mark) would stay empty for the rest of the 5 minutes.
 * A failed message is not retried and never shown.
 */
import type { BgResponse, ToBackground } from '@/shared/messages';
import { TIMING } from './config';

export interface GroupInfoDeps {
  now(): number;
  /** Is an account known to the page right now (`LOCAL.lastAccount`)? */
  hasAccount(): boolean;
  /** Sends one message to the worker; null when it could not be delivered. Never rejects. */
  send(message: ToBackground): Promise<BgResponse<unknown> | null>;
  /**
   * A short retry is due: make the page look at itself again (a pass that sees the server calls `seen` again). An idle page has
   * no pass of its own to wait for. Optional.
   */
  retryDue?(): void;
}

interface Sent {
  at: number;
  /** The worker could not use it for lack of an account: report again when one shows up. */
  needsAccount: boolean;
  /** The worker answered `no-account`: worth another try soon (until `retries` is used up). */
  retryable: boolean;
  /** How many short retries this 5-minute window has had. */
  retries: number;
}

export class GroupInfoReporter {
  private readonly sent = new Map<string, Sent>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly deps: GroupInfoDeps) {}

  /** The page shows server `guildId` (its channel list or header). `guildName` is only read when something is sent. */
  seen(guildId: string, guildName: () => string | null): void {
    if (this.disposed) return;
    const now = this.deps.now();
    const previous = this.sent.get(guildId);
    let retries = 0;
    if (previous && now - previous.at < TIMING.groupInfoMs) {
      const retry = previous.retryable && previous.retries < TIMING.groupInfoRetries && now - previous.at >= TIMING.groupInfoRetryMs;
      if (!retry) return;
      retries = previous.retries + 1;
    }
    const entry: Sent = { at: now, needsAccount: !this.deps.hasAccount(), retryable: false, retries };
    this.sent.set(guildId, entry);
    void this.deps
      .send({ to: 'bg', type: 'queue/groupInfo', guildId, guildName: guildName() })
      .then((response) => {
        if (response && !response.ok && response.error === 'no-account') {
          entry.needsAccount = true;
          entry.retryable = true;
          this.armRetry(guildId, entry);
        }
      })
      .catch(() => undefined); // nothing here may surface in Discord's console
  }

  /** An account became known: servers that were reported without one are reported again the next time they are seen. */
  accountKnown(): void {
    for (const [guildId, entry] of Array.from(this.sent)) {
      if (entry.needsAccount) this.forget(guildId);
    }
  }

  /** Stops the retry timers (the content script is torn down). */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.sent.clear();
  }

  private forget(guildId: string): void {
    this.sent.delete(guildId);
    clearTimeout(this.timers.get(guildId));
    this.timers.delete(guildId);
  }

  /** One timer per server, only while a short retry is still allowed: when it fires the page is asked to look at itself again. */
  private armRetry(guildId: string, entry: Sent): void {
    if (this.disposed || this.sent.get(guildId) !== entry || entry.retries >= TIMING.groupInfoRetries) return;
    clearTimeout(this.timers.get(guildId));
    this.timers.set(
      guildId,
      setTimeout(() => {
        this.timers.delete(guildId);
        if (this.disposed) return;
        try {
          this.deps.retryDue?.();
        } catch {
          // a retry that cannot be nudged simply waits for the next pass
        }
      }, TIMING.groupInfoRetryMs),
    );
  }
}
