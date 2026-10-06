import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupInfoReporter, type GroupInfoDeps } from '@/content/groupInfo';
import type { BgResponse, ToBackground } from '@/shared/messages';

const MINUTE = 60_000;
const SECOND = 1_000;

afterEach(() => {
  vi.useRealTimers();
});

/** A reporter with a clock, an account flag and a worker the test steers. */
function setup(answer: () => BgResponse<unknown> | null | Promise<BgResponse<unknown> | null> = () => ({ ok: true, data: undefined })) {
  const state = { now: 1_000_000, account: true };
  const sent: ToBackground[] = [];
  const nudges = { count: 0 };
  const deps: GroupInfoDeps = {
    now: () => state.now,
    hasAccount: () => state.account,
    send: async (message) => {
      sent.push(message);
      return answer();
    },
    retryDue: () => void nudges.count++,
  };
  const reporter = new GroupInfoReporter(deps);
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { state, sent, nudges, reporter, settle };
}

describe('GroupInfoReporter: once per server per 5 minutes', () => {
  it('sends queue/groupInfo with the guild and its name', () => {
    const { reporter, sent } = setup();
    reporter.seen('111', () => 'Server One');
    expect(sent).toEqual([{ to: 'bg', type: 'queue/groupInfo', guildId: '111', guildName: 'Server One' }]);
  });

  it('a name that is not known is sent as null', () => {
    const { reporter, sent } = setup();
    reporter.seen('111', () => null);
    expect(sent).toEqual([{ to: 'bg', type: 'queue/groupInfo', guildId: '111', guildName: null }]);
  });

  it('the name is only looked up when something is sent', () => {
    const { reporter } = setup();
    const name = vi.fn(() => 'Server One');
    reporter.seen('111', name);
    reporter.seen('111', name);
    reporter.seen('111', name);
    expect(name).toHaveBeenCalledTimes(1);
  });

  it('the same server is not sent again before 5 minutes have passed, and is after', () => {
    const { reporter, sent, state } = setup();
    reporter.seen('111', () => 'S');
    state.now += 5 * MINUTE - 1;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(1);
    state.now += 1;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2);
    state.now += 5 * MINUTE - 1;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2); // the next 5 minutes count from the last send
  });

  it('each server has its own clock', () => {
    const { reporter, sent, state } = setup();
    reporter.seen('111', () => 'S1');
    state.now += 2 * MINUTE;
    reporter.seen('222', () => 'S2');
    reporter.seen('111', () => 'S1');
    expect(sent.map((m) => (m as { guildId: string }).guildId)).toEqual(['111', '222']);
    state.now += 3 * MINUTE;
    reporter.seen('111', () => 'S1');
    reporter.seen('222', () => 'S2');
    expect(sent.map((m) => (m as { guildId: string }).guildId)).toEqual(['111', '222', '111']);
  });

  it('a failed send is not retried before the 5 minutes are over (and nothing is thrown)', async () => {
    for (const answer of [() => null, () => ({ ok: false, error: 'http' }) as BgResponse<unknown>, () => Promise.reject(new Error('boom'))]) {
      const { reporter, sent, settle } = setup(answer);
      expect(() => reporter.seen('111', () => 'S')).not.toThrow();
      await settle();
      reporter.seen('111', () => 'S');
      expect(sent).toHaveLength(1);
    }
  });
});

describe('GroupInfoReporter: an account that shows up later', () => {
  it('a server sent while no account was known is sent again, at the next sight, once an account is known', () => {
    const { reporter, sent, state } = setup();
    state.account = false;
    reporter.seen('111', () => 'S');
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(1); // the worker may still know it: tried once, then throttled
    state.account = true;
    reporter.accountKnown();
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2);
    reporter.accountKnown();
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2); // the second send had an account: throttled as usual
  });

  it('only the servers that were sent without an account are sent again', () => {
    const { reporter, sent, state } = setup();
    state.account = false;
    reporter.seen('111', () => 'S1');
    state.account = true;
    reporter.seen('222', () => 'S2');
    sent.length = 0;
    reporter.accountKnown();
    reporter.seen('111', () => 'S1');
    reporter.seen('222', () => 'S2');
    expect(sent.map((m) => (m as { guildId: string }).guildId)).toEqual(['111']);
  });

  it('nothing is sent by accountKnown itself (it waits for the next sight of the server)', () => {
    const { reporter, sent, state } = setup();
    state.account = false;
    reporter.seen('111', () => 'S');
    sent.length = 0;
    state.account = true;
    reporter.accountKnown();
    expect(sent).toEqual([]);
  });

  it('a worker answer of no-account counts as "without an account" too, even when the page knew one', async () => {
    const { reporter, sent, settle } = setup(() => ({ ok: false, error: 'no-account' }));
    reporter.seen('111', () => 'S');
    await settle();
    reporter.accountKnown();
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2);
  });

  it('other answers do not', async () => {
    const answers: (() => BgResponse<unknown> | null)[] = [
      () => ({ ok: true, data: undefined }),
      () => ({ ok: false, error: 'no-consent' }),
      () => null,
    ];
    for (const answer of answers) {
      const { reporter, sent, settle } = setup(answer);
      reporter.seen('111', () => 'S');
      await settle();
      reporter.accountKnown();
      reporter.seen('111', () => 'S');
      expect(sent).toHaveLength(1);
    }
  });
});

describe('GroupInfoReporter: a worker that answered no-account is asked again soon (the account did not change, so no event says "now")', () => {
  const noAccount = (): BgResponse<unknown> => ({ ok: false, error: 'no-account' });

  it('after 20 seconds the next sight sends again, not before', async () => {
    const { reporter, sent, state, settle } = setup(noAccount);
    reporter.seen('111', () => 'S');
    await settle();
    state.now += 20 * SECOND - 1;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(1);
    state.now += 1;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2);
    await settle();
    state.now += 19 * SECOND;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2); // the next retry counts from the last send
    state.now += 1 * SECOND;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(3);
  });

  it('it stops once the worker has an account: an answered send is throttled for the 5 minutes', async () => {
    let answerOk = false;
    const { reporter, sent, state, settle } = setup(() => (answerOk ? { ok: true, data: undefined } : noAccount()));
    reporter.seen('111', () => 'S');
    await settle();
    answerOk = true;
    state.now += 20 * SECOND;
    reporter.seen('111', () => 'S');
    await settle();
    expect(sent).toHaveLength(2);
    state.now += 4 * MINUTE;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2);
    state.now += 1 * MINUTE;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(3);
  });

  it('it is capped: 6 short retries, then the 5-minute throttle, and then a fresh allowance', async () => {
    const { reporter, sent, state, settle } = setup(noAccount);
    const start = state.now;
    reporter.seen('111', () => 'S');
    await settle();
    for (let i = 0; i < 12; i++) {
      state.now += 20 * SECOND;
      reporter.seen('111', () => 'S');
      await settle();
    }
    expect(sent).toHaveLength(7); // the first send and 6 retries (2 minutes), nothing more in the 2 minutes after
    state.now = start + 2 * MINUTE + 5 * MINUTE - 1; // 5 minutes count from the last send
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(7);
    state.now += 1;
    reporter.seen('111', () => 'S');
    await settle();
    expect(sent).toHaveLength(8); // the 5-minute window is over: a regular send
    state.now += 20 * SECOND;
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(9); // and its retries start again
  });

  it('each server has its own retries; other answers and failures get none', async () => {
    const answers: (() => BgResponse<unknown> | null | Promise<never>)[] = [
      () => ({ ok: true, data: undefined }),
      () => ({ ok: false, error: 'no-consent' }),
      () => ({ ok: false, error: 'http' }),
      () => null,
      () => Promise.reject(new Error('boom')),
    ];
    for (const answer of answers) {
      const { reporter, sent, state, settle } = setup(answer);
      reporter.seen('111', () => 'S');
      await settle();
      state.now += 30 * SECOND;
      reporter.seen('111', () => 'S');
      expect(sent).toHaveLength(1);
    }
    const { reporter, sent, state, settle } = setup(noAccount);
    reporter.seen('111', () => 'S1');
    await settle();
    state.now += 10 * SECOND;
    reporter.seen('222', () => 'S2');
    await settle();
    state.now += 10 * SECOND; // 20 s after the first server, 10 s after the second
    reporter.seen('111', () => 'S1');
    reporter.seen('222', () => 'S2');
    expect(sent.map((m) => (m as { guildId: string }).guildId)).toEqual(['111', '222', '111']);
  });

  it('an account that becomes known still resets it at once, retries or not', async () => {
    const { reporter, sent, state, settle } = setup(noAccount);
    reporter.seen('111', () => 'S');
    await settle();
    state.now += 1 * SECOND;
    reporter.accountKnown();
    reporter.seen('111', () => 'S');
    expect(sent).toHaveLength(2);
  });

  describe('the nudge: an idle page gets a pass of its own when a retry is due', () => {
    it('fires 20 seconds after a no-account answer, once, and not for any other answer', async () => {
      vi.useFakeTimers();
      const { reporter, nudges, settle } = setup(noAccount);
      reporter.seen('111', () => 'S');
      await settle();
      await vi.advanceTimersByTimeAsync(20 * SECOND - 1);
      expect(nudges.count).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(nudges.count).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(nudges.count).toBe(1); // asked for once; the pass that follows decides what is sent

      const others: (() => BgResponse<unknown> | null)[] = [
        () => ({ ok: true, data: undefined }),
        () => null,
        () => ({ ok: false, error: 'http' }),
      ];
      for (const answer of others) {
        const other = setup(answer);
        other.reporter.seen('111', () => 'S');
        await other.settle();
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        expect(other.nudges.count).toBe(0);
      }
    });

    it('goes on while retries are left and stops after the last one', async () => {
      vi.useFakeTimers();
      const { reporter, state, nudges, sent, settle } = setup(noAccount);
      reporter.seen('111', () => 'S');
      await settle();
      for (let i = 0; i < 10; i++) {
        state.now += 20 * SECOND;
        await vi.advanceTimersByTimeAsync(20 * SECOND);
        reporter.seen('111', () => 'S'); // the pass the nudge asked for
        await settle();
      }
      expect(sent).toHaveLength(7);
      expect(nudges.count).toBe(6); // the 6th retry is the last one: nothing is armed after it
    });

    it('is cancelled by accountKnown (the next sight sends the server again anyway) and by dispose', async () => {
      vi.useFakeTimers();
      const first = setup(noAccount);
      first.reporter.seen('111', () => 'S');
      await first.settle();
      first.reporter.accountKnown();
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(first.nudges.count).toBe(0);

      const second = setup(noAccount);
      second.reporter.seen('111', () => 'S');
      await second.settle();
      second.reporter.dispose();
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(second.nudges.count).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      second.reporter.seen('111', () => 'S');
      expect(second.sent).toHaveLength(1); // a disposed reporter sends nothing
    });

    it('a nudge that throws is swallowed', async () => {
      vi.useFakeTimers();
      let called = 0;
      const reporter = new GroupInfoReporter({
        now: () => 1,
        hasAccount: () => true,
        send: async () => ({ ok: false, error: 'no-account' }),
        retryDue: () => {
          called++;
          throw new Error('boom');
        },
      });
      reporter.seen('111', () => 'S');
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(MINUTE); // would reject if the throw got out of the timer
      expect(called).toBe(1);
    });
  });
});
