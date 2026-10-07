// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthReporter } from '@/content/health';
import type { PassStats } from '@/content/inject/injector';
import type { InjectHealth } from '@/shared/types';
import { boot, type Booted } from './helpers/app';
import { ID, byKey, categoryRow, channelRow, dmRow, sidebar } from './helpers/fixtures';

let ctx: Booted | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  history.pushState({}, '', '/channels/100000000000000001/200000000000000001?query=1#frag');
  vi.useFakeTimers();
});

afterEach(() => {
  ctx?.app.destroy();
  ctx = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const reports = (): { ok: boolean; reason: string | null }[] =>
  ctx!.chrome.sentOf('inject/health').map((m) => ({ ok: m.health.ok, reason: m.health.reason }));

describe('in the running content script', () => {
  it('ok: true once the first button is in, with a timestamp and no page address', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const [message] = ctx.chrome.sentOf('inject/health');
    expect(message).toEqual({
      to: 'bg',
      type: 'inject/health',
      health: { ok: true, reason: null, checkedAt: expect.any(Number) },
    });
    expect(ctx.chrome.sentOf('inject/health')).toHaveLength(1);
  });

  it('is throttled: more passes do not send it again within five minutes, then it is a heartbeat', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    for (let i = 0; i < 5; i++) {
      document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: `20000000000000010${i}`, name: `room ${i}` }));
      await ctx.frame();
    }
    expect(reports()).toEqual([{ ok: true, reason: null }]);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: '200000000000000110', name: 'another' }));
    await ctx.frame();
    expect(reports()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: '200000000000000111', name: 'one more' }));
    await ctx.frame();
    expect(reports()).toEqual([{ ok: true, reason: null }, { ok: true, reason: null }]);
  });

  it('rows but no icon container for more than 10 s: ok: false with a reason', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', container: false }), channelRow({ id: ID.random, name: 'random', container: false })) });
    await vi.advanceTimersByTimeAsync(9_900);
    expect(reports()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(reports()).toEqual([{ ok: false, reason: 'no-icon-container (2 of 2 rows)' }]);
    const [message] = ctx.chrome.sentOf('inject/health');
    expect(message!.health.checkedAt).toEqual(expect.any(Number));
    expect(Object.keys(message!.health).sort()).toEqual(['checkedAt', 'ok', 'reason']);
  });

  it('says ok: true again as soon as injection works (Discord shows the container later)', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', container: false })) });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(reports()).toEqual([{ ok: false, reason: 'no-icon-container (1 of 1 rows)' }]);
    const link = document.querySelector('a[data-list-item-id]')!;
    link.insertAdjacentHTML('beforeend', '<div class="children__2ea32"></div>');
    await ctx.frame();
    expect(byKey(ID.general)).not.toBeNull();
    expect(reports()).toEqual([
      { ok: false, reason: 'no-icon-container (1 of 1 rows)' },
      { ok: true, reason: null },
    ]);
  });

  it('a page where some rows work is healthy (rows of another kind may lack a container)', async () => {
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general' }), channelRow({ id: ID.random, name: 'random', container: false })),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports()).toEqual([{ ok: true, reason: null }]);
  });

  it('a failing pass later does not turn a healthy page into a failing one while buttons exist', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: ID.random, name: 'random', container: false }));
    await ctx.frame();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports()).toEqual([{ ok: true, reason: null }]);
  });

  it('no rows at all (friends page, settings, an empty server) is nothing to report', async () => {
    ctx = await boot({ html: '<div id="app">Friends</div>' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports()).toEqual([]);
  });

  it('rows that are gone again before the 10 s are not reported', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', container: false })) });
    await vi.advanceTimersByTimeAsync(5_000);
    document.querySelector('ul')!.innerHTML = ''; // navigated away
    await ctx.frame();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
  });

  it('a standing failure is not repeated every 10 s, only as a heartbeat', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', container: false })) });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(reports()).toHaveLength(1);
    const noise = (n: number) => document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: `20000000000000020${n}`, name: `x${n}`, container: false }));
    noise(1);
    await ctx.frame();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports()).toHaveLength(1); // same state, same reason, within five minutes
    await vi.advanceTimersByTimeAsync(300_000);
    noise(2);
    await ctx.frame();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(reports().map((r) => r.ok)).toEqual([false, false]);
  });

  it('works for every kind of row: a DM page with no container is reported too', async () => {
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex' }).replace('iconsContainer__972a0', 'somethingElse__972a0') });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(reports()).toEqual([{ ok: false, reason: 'no-icon-container (1 of 1 rows)' }]);
  });

  it('a category page with a container but only a category: healthy', async () => {
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })) });
    expect(reports()).toEqual([{ ok: true, reason: null }]);
  });

  const unknownRows =
    '<ul><li class="containerDefault_c69b6d" data-dnd-name="general"><div class="x"></div></li><li class="containerDefault_c69b6d" data-dnd-name="random"></li></ul>';

  it('channel list items that look like rows but none is one we know (Discord changed what rows hang on): reported too', async () => {
    ctx = await boot({ html: unknownRows });
    await vi.advanceTimersByTimeAsync(9_900);
    expect(reports()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(reports()).toEqual([{ ok: false, reason: 'unrecognized-rows (2 list items, none a known row)' }]);
  });

  it('a stray list item next to rows that work is nothing to worry about', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) + unknownRows });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports()).toEqual([{ ok: true, reason: null }]);
  });

  it('rows that appear after the first scan and are not ones we know are found by the 10 s watchdog (a full scan), then reported', async () => {
    ctx = await boot({ html: '<div id="app">loading</div>' });
    expect(reports()).toEqual([]);
    document.body.insertAdjacentHTML('beforeend', unknownRows);
    await ctx.frame(); // an incremental pass: it looks only at what was added and sees no known row
    await vi.advanceTimersByTimeAsync(9_000);
    expect(reports()).toEqual([]);
    await ctx.frame();
    await vi.advanceTimersByTimeAsync(2_000); // the watchdog ticks at 10 s...
    await ctx.frame();
    await vi.advanceTimersByTimeAsync(10_500); // ...and the failure stands for 10 s
    expect(reports()).toEqual([{ ok: false, reason: 'unrecognized-rows (2 list items, none a known row)' }]);
  });

  it('the watchdog is quiet on a healthy page and on a page without rows', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const scans = vi.spyOn(ctx.app.injector, 'requestFullScan');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scans).not.toHaveBeenCalled(); // buttons exist: nothing to look for
    ctx.app.destroy();
    ctx = await boot({ html: '<div>Friends</div>' });
    const idleScans = vi.spyOn(ctx.app.injector, 'requestFullScan');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idleScans).not.toHaveBeenCalled(); // no rows: nothing to look for
  });

  it('the unknown rows are gone before 10 s (another page): no report', async () => {
    ctx = await boot({ html: unknownRows });
    await vi.advanceTimersByTimeAsync(5_000);
    document.body.innerHTML = '<div>Friends</div>';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
  });
});

describe('HealthReporter (unit)', () => {
  const stats = (rows: number, ok: number, noContainer: number, errors = 0, unrecognized = 0): PassStats => ({ rows, ok, noContainer, errors, unrecognized });

  const setup = (state: { buttons: boolean; rows: boolean } = { buttons: false, rows: true }) => {
    const sent: InjectHealth[] = [];
    const reporter = new HealthReporter({
      send: (health) => sent.push(health),
      now: () => Date.now(),
      hasButtons: () => state.buttons,
      hasRows: () => state.rows,
    });
    return { reporter, sent, state };
  };

  it('errors while injecting count as a failure too, with their own reason', () => {
    const { reporter, sent } = setup();
    reporter.onPass(stats(3, 0, 0, 3));
    vi.advanceTimersByTime(10_001);
    expect(sent).toEqual([{ ok: false, reason: 'inject-error (3 of 3 rows)', checkedAt: expect.any(Number) }]);
  });

  it('a success before the deadline cancels the pending failure', () => {
    const { reporter, sent, state } = setup();
    reporter.onPass(stats(2, 0, 2));
    vi.advanceTimersByTime(5_000);
    state.buttons = true;
    reporter.onPass(stats(2, 2, 0));
    vi.advanceTimersByTime(60_000);
    expect(sent.map((h) => h.ok)).toEqual([true]);
  });

  it('onStopped says nothing when nothing was wrong, and clears a pending failure', () => {
    const { reporter, sent } = setup();
    reporter.onPass(stats(2, 0, 2));
    reporter.onStopped();
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });

  it('onStopped after a failure reports ok with reason "disabled"; switching on again reports ok normally', () => {
    const { reporter, sent, state } = setup();
    reporter.onPass(stats(1, 0, 1));
    vi.advanceTimersByTime(10_001);
    reporter.onStopped();
    expect(sent.map((h) => [h.ok, h.reason])).toEqual([[false, 'no-icon-container (1 of 1 rows)'], [true, 'disabled']]);
    state.buttons = true;
    reporter.onPass(stats(1, 1, 0));
    expect(sent.map((h) => [h.ok, h.reason]).at(-1)).toEqual([true, null]);
  });

  it('a pass that saw only unrecognised list items is a failure too, with its own reason', () => {
    const { reporter, sent } = setup();
    reporter.onPass(stats(0, 0, 0, 0, 4));
    vi.advanceTimersByTime(10_001);
    expect(sent.map((h) => [h.ok, h.reason])).toEqual([[false, 'unrecognized-rows (4 list items, none a known row)']]);
  });

  it('a standing failure is one report, whatever the row counts say later; a new cause is a new report', () => {
    const { reporter, sent } = setup();
    reporter.onPass(stats(2, 0, 2));
    vi.advanceTimersByTime(10_001);
    reporter.onPass(stats(5, 0, 5)); // more rows now, same trouble
    vi.advanceTimersByTime(10_001);
    expect(sent).toHaveLength(1);
    reporter.onPass(stats(0, 0, 0, 0, 3)); // a different trouble
    vi.advanceTimersByTime(10_001);
    expect(sent.map((h) => h.reason)).toEqual(['no-icon-container (2 of 2 rows)', 'unrecognized-rows (3 list items, none a known row)']);
  });

  it('a pass with nothing to report arms nothing', () => {
    const { reporter, sent } = setup();
    reporter.onPass(stats(0, 0, 0));
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });

  it('dispose() cancels a pending failure', () => {
    const { reporter, sent } = setup();
    reporter.onPass(stats(1, 0, 1));
    reporter.dispose();
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });
});
