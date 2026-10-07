// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POLL_MS, activeAccountOf, createPopupStore, isJobActive, type PopupStore } from '@/popup/store';
import { DEFAULT_APP_SETTINGS, DEFAULT_EXPORT_SETTINGS, LOCAL, SESSION, type JobState, type QueueItem } from '@/shared';
import { MOCK_ACCOUNT, MOCK_CATEGORIES, MOCK_GUILDS, MOCK_TARGETS, TREE_TARGETS, createMockPlatform, sampleHistory, sampleRunningJob, type MockPlatform, type MockScenario } from '@/ui/platform/mock';

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Creates a store on a mock platform, starts it and waits for the first reads. */
async function started(scenario: MockScenario = 'idle', pollMs = 600_000): Promise<{ platform: MockPlatform; store: PopupStore }> {
  const platform = createMockPlatform({ scenario });
  const store = createPopupStore(platform, { pollMs });
  stops.push(store.getState().start());
  await flush();
  return { platform, store };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const statusCalls = (platform: MockPlatform): number => platform.sent.filter((message) => message.type === 'status/get').length;

const SECOND_ACCOUNT = { id: '100000000000000002', username: 'second_user', globalName: null, avatarUrl: '' };
const secondQueue = (): QueueItem[] => [{ key: '900', target: { ...MOCK_TARGETS.dm, channelId: '900', channelName: 'Second Friend' }, settings: null, addedAt: 1 }];

describe('starting', () => {
  it('nothing is loaded before start()', () => {
    const store = createPopupStore(createMockPlatform());
    expect(store.getState()).toMatchObject({ loaded: false, queueLoaded: false, statusLoaded: false, queue: [], history: [], job: null, account: null, theme: null });
    expect(store.getState().settings).toEqual(DEFAULT_APP_SETTINGS);
    expect(store.getState().settings).not.toBe(DEFAULT_APP_SETTINGS);
  });

  it('start() reads settings, theme, accounts, job, health, the list and the history, then asks the background for the status', async () => {
    const { store, platform } = await started('running');
    const state = store.getState();
    expect(state.loaded).toBe(true);
    expect(state.queueLoaded).toBe(true);
    expect(state.statusLoaded).toBe(true);
    expect(state.settings.consentAt).not.toBeNull();
    expect(state.theme).toMatchObject({ scheme: 'dark', lang: 'ko' });
    expect(state.account).toMatchObject({ username: 'sample_user' });
    expect(state.lastAccount).toMatchObject({ username: 'sample_user' });
    expect(state.job?.state).toBe('running');
    expect(state.health?.ok).toBe(true);
    expect(state.queue).toHaveLength(4);
    expect(state.history).toHaveLength(4); // the three of the sample data + the chat of the running job that is already done
    expect(state.discordTabs).toBe(1);
    expect(statusCalls(platform)).toBe(1);
  });

  it('reads only keys the popup may read (never the authentication keys)', async () => {
    const platform = createMockPlatform();
    const read: string[] = [];
    const getStorage = platform.getStorage.bind(platform);
    platform.getStorage = async (area, keys) => {
      read.push(...keys);
      return getStorage(area, keys);
    };
    const store = createPopupStore(platform);
    stops.push(store.getState().start());
    await flush();
    expect(read).toContain(LOCAL.settings);
    expect(read).toContain(SESSION.job);
    expect(read).not.toContain(SESSION.token);
    expect(read).not.toContain(SESSION.tokenCapturedAt);
  });

  it('storage that fails to read leaves the defaults: the popup still comes up', async () => {
    const platform = createMockPlatform();
    platform.getStorage = async () => {
      throw new Error('storage unavailable');
    };
    const store = createPopupStore(platform);
    stops.push(store.getState().start());
    await flush();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().queueLoaded).toBe(true);
    expect(store.getState().settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('without storage.session the account and job come from status/get alone', async () => {
    const platform = createMockPlatform({ scenario: 'running' });
    const getStorage = platform.getStorage.bind(platform);
    platform.getStorage = async (area, keys) => {
      if (area === 'session') throw new Error('no session storage');
      return getStorage(area, keys);
    };
    const store = createPopupStore(platform);
    stops.push(store.getState().start());
    await flush();
    expect(store.getState().account).toMatchObject({ username: 'sample_user' });
    expect(store.getState().job?.state).toBe('running');
  });

  it('the function it returns stops everything: no more events, no more polls', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const platform = createMockPlatform();
    const store = createPopupStore(platform, { pollMs: 2000 });
    const stop = store.getState().start();
    await flush();
    const before = statusCalls(platform);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusCalls(platform)).toBe(before);
    platform.write('local', { [LOCAL.theme]: { scheme: 'light', themeClasses: [], vars: {}, lang: 'en', capturedAt: 1 } });
    await flush();
    expect(store.getState().theme?.scheme).toBe('dark');
  });
});

describe('polling status/get (docs/PLAN.md §7.2: on open and every 2 seconds)', () => {
  it('the default interval is 2 seconds', () => {
    expect(POLL_MS).toBe(2000);
  });

  it('asks on open and then every interval while open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const platform = createMockPlatform();
    const store = createPopupStore(platform, { pollMs: POLL_MS });
    stops.push(store.getState().start());
    await flush();
    expect(statusCalls(platform)).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(statusCalls(platform)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls(platform)).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(statusCalls(platform)).toBe(4);
  });

  it('picks up what only the background knows (no storage change): a Discord tab, the health of the page', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const platform = createMockPlatform();
    const store = createPopupStore(platform, { pollMs: 2000 });
    stops.push(store.getState().start());
    await flush();
    expect(store.getState().discordTabs).toBe(1);
    platform.setDiscordTabs(3);
    platform.setHealth({ ok: false, reason: 'changed', checkedAt: 5 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().discordTabs).toBe(3);
    expect(store.getState().health).toMatchObject({ ok: false, reason: 'changed' });
  });

  it('never has two requests on the way at once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const platform = createMockPlatform();
    const send = platform.sendMessage.bind(platform);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    platform.sendMessage = (async (message) => {
      if (message.type === 'status/get') {
        calls++;
        if (calls === 1) await gate;
      }
      return send(message);
    }) as typeof platform.sendMessage;
    const store = createPopupStore(platform, { pollMs: 2000 });
    stops.push(store.getState().start());
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1); // the first one has not come back: no pile-up
    release();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
  });

  it('does not poll while the page is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const platform = createMockPlatform();
    const store = createPopupStore(platform, { pollMs: 2000 });
    stops.push(store.getState().start());
    await flush();
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(6000);
    expect(statusCalls(platform)).toBe(1);
    hidden.mockReturnValue('visible');
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusCalls(platform)).toBe(2);
  });

  it('a status that cannot be delivered marks the connection as lost until one gets through', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const platform = createMockPlatform();
    const send = platform.sendMessage.bind(platform);
    let down = false;
    platform.sendMessage = (async (message) => (message.type === 'status/get' && down ? { ok: false, error: 'unknown', message: 'no connection' } : send(message))) as typeof platform.sendMessage;
    const store = createPopupStore(platform, { pollMs: 2000 });
    stops.push(store.getState().start());
    await flush();
    expect(store.getState().connectionLost).toBe(false);
    down = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().connectionLost).toBe(true);
    expect(store.getState().statusLoaded).toBe(true); // what was known stays
    down = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().connectionLost).toBe(false);
  });

  it('a platform that rejects anyway (it should not) is handled like an error response, never as an unhandled rejection', async () => {
    const platform = createMockPlatform();
    platform.sendMessage = async () => {
      throw new Error('port closed');
    };
    const store = createPopupStore(platform, { pollMs: 600_000 });
    stops.push(store.getState().start());
    await flush();
    expect(store.getState().connectionLost).toBe(true);
    expect(await store.getState().removeItem('1')).toBe(false);
    expect(store.getState().notice).toMatchObject({ code: 'unknown', message: 'port closed' });
    expect(await store.getState().patchSettings({ showButtons: false })).toBe(false);
    expect(store.getState().settings.showButtons).toBe(true); // rolled back
  });

  it('a malformed status is treated as a failure', async () => {
    const platform = createMockPlatform();
    platform.sendMessage = (async () => ({ ok: true, data: 'not a snapshot' })) as typeof platform.sendMessage;
    const store = createPopupStore(platform, { pollMs: 600_000 });
    stops.push(store.getState().start());
    await flush();
    expect(store.getState().connectionLost).toBe(true);
  });
});

describe('following storage changes', () => {
  it('settings, the theme, the last account and the job', async () => {
    const { platform, store } = await started('idle');
    platform.write('local', { [LOCAL.settings]: { ...store.getState().settings, language: 'en', showButtons: false } });
    platform.write('local', { [LOCAL.theme]: { scheme: 'light', themeClasses: ['theme-light'], vars: { '--brand-500': '#123' }, lang: 'en', capturedAt: 9 } });
    await flush();
    expect(store.getState().settings).toMatchObject({ language: 'en', showButtons: false });
    expect(store.getState().theme).toMatchObject({ scheme: 'light', lang: 'en' });

    platform.write('session', { [SESSION.job]: sampleRunningJob(Date.now()) });
    await flush();
    expect(store.getState().job?.state).toBe('running');
    platform.write('session', { [SESSION.job]: null });
    await flush();
    expect(store.getState().job).toBeNull();
  });

  it('the list and the history of the active account', async () => {
    const { platform, store } = await started('idle');
    const queue = platform.read('local', LOCAL.queue(MOCK_ACCOUNT.id)) as QueueItem[];
    platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: queue.slice(0, 2) });
    platform.write('local', { [LOCAL.history(MOCK_ACCOUNT.id)]: sampleHistory(Date.now()).slice(0, 1) });
    await flush();
    expect(store.getState().queue).toHaveLength(2);
    expect(store.getState().history).toHaveLength(1);
    platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: undefined });
    await flush();
    expect(store.getState().queue).toEqual([]);
  });

  it('ignores the list of an account that is not the active one', async () => {
    const { platform, store } = await started('idle');
    platform.write('local', { [LOCAL.queue('555')]: secondQueue() });
    await flush();
    expect(store.getState().queue).toHaveLength(5);
  });

  it('switching to another account shows that account\'s list and history', async () => {
    const { platform, store } = await started('idle');
    platform.write('local', { [LOCAL.queue(SECOND_ACCOUNT.id)]: secondQueue(), [LOCAL.history(SECOND_ACCOUNT.id)]: [] });
    platform.write('session', { [SESSION.account]: SECOND_ACCOUNT });
    await flush();
    expect(store.getState().account).toMatchObject({ username: 'second_user' });
    expect(activeAccountOf(store.getState())?.id).toBe(SECOND_ACCOUNT.id);
    expect(store.getState().queue.map((item) => item.key)).toEqual(['900']);
    expect(store.getState().history).toEqual([]);
  });

  it('with no live account the last known one still gives its list', async () => {
    const { platform, store } = await started('idle');
    platform.write('session', { [SESSION.account]: null });
    await flush();
    expect(store.getState().account).toBeNull();
    expect(store.getState().queue).toHaveLength(5);
    // and when even that is gone: nothing
    platform.write('local', { [LOCAL.lastAccount]: undefined });
    await flush();
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().history).toEqual([]);
  });

  it('the account of status/get replaces the one from storage, and a changed account reloads the list', async () => {
    const platform = createMockPlatform({ scenario: 'idle' });
    platform.write('local', { [LOCAL.queue(SECOND_ACCOUNT.id)]: secondQueue() });
    const send = platform.sendMessage.bind(platform);
    platform.sendMessage = (async (message) =>
      message.type === 'status/get' ? { ok: true, data: { account: SECOND_ACCOUNT, lastAccount: SECOND_ACCOUNT, discordTabs: 2, health: null, job: null } } : send(message)) as typeof platform.sendMessage;
    const store = createPopupStore(platform, { pollMs: 600_000 });
    stops.push(store.getState().start());
    await flush();
    expect(store.getState().account?.username).toBe('second_user');
    expect(store.getState().queue.map((item) => item.key)).toEqual(['900']);
    expect(store.getState().discordTabs).toBe(2);
  });

  it('the most recent report of the page health wins', async () => {
    const { platform, store } = await started('idle');
    platform.write('session', {
      [SESSION.injectHealth]: {
        '1': { ok: true, reason: null, checkedAt: 10, url: 'a' },
        '2': { ok: false, reason: 'broken', checkedAt: 20, url: 'b' },
      },
    });
    await flush();
    expect(store.getState().health).toMatchObject({ ok: false, reason: 'broken' });
  });

  it('garbage in storage becomes defaults or nothing, never an exception', async () => {
    const { platform, store } = await started('idle');
    platform.write('local', { [LOCAL.settings]: 'garbage', [LOCAL.theme]: 5, [LOCAL.lastAccount]: { id: 5 } });
    platform.write('session', { [SESSION.job]: { state: 'dancing' }, [SESSION.account]: [] });
    await flush();
    expect(store.getState().settings).toEqual(DEFAULT_APP_SETTINGS);
    expect(store.getState().theme).toBeNull();
    expect(store.getState().job).toBeNull();
    expect(store.getState().account).toBeNull();
  });
});

describe('patchSettings (optimistic)', () => {
  it('the screen changes at once; the background has the same change afterwards', async () => {
    const { platform, store } = await started('idle');
    const done = store.getState().patchSettings({ showButtons: false });
    expect(store.getState().settings.showButtons).toBe(false);
    expect(await done).toBe(true);
    expect(platform.read('local', LOCAL.settings)).toMatchObject({ showButtons: false });
    expect(store.getState().settings.showButtons).toBe(false);
  });

  it('sends a copy of the patch: changing the object afterwards changes nothing', async () => {
    const { platform, store } = await started('idle');
    const patch = { common: { ...store.getState().settings.common, count: 5 } };
    const done = store.getState().patchSettings(patch);
    patch.common.count = 999;
    await done;
    expect(platform.sent.filter((message) => message.type === 'settings/patch')[0]).toMatchObject({ patch: { common: { count: 5 } } });
    expect(store.getState().settings.common.count).toBe(5);
  });

  it('a refusal rolls it back from storage and sets the notice', async () => {
    const { platform, store } = await started('idle');
    platform.failNext('settings/patch', 'unknown', 'boom');
    expect(await store.getState().patchSettings({ showButtons: false })).toBe(false);
    expect(store.getState().settings.showButtons).toBe(true);
    expect(store.getState().notice).toMatchObject({ code: 'unknown', message: 'boom' });
  });

  it('not optimistic when asked (the consent): the screen waits for the answer', async () => {
    const { store } = await started('consent');
    expect(store.getState().settings.consentAt).toBeNull();
    const done = store.getState().patchSettings({ consentAt: 123 }, { optimistic: false });
    expect(store.getState().settings.consentAt).toBeNull();
    expect(await done).toBe(true);
    expect(store.getState().settings.consentAt).toBe(123);
  });

  it('not optimistic and refused: nothing changed, the notice is there', async () => {
    const { platform, store } = await started('consent');
    platform.failNext('settings/patch', 'unknown');
    expect(await store.getState().patchSettings({ consentAt: 123 }, { optimistic: false })).toBe(false);
    expect(store.getState().settings.consentAt).toBeNull();
    expect(store.getState().notice?.code).toBe('unknown');
  });

  it('several changes in a row all arrive, in order, and the last one wins', async () => {
    const { platform, store } = await started('idle');
    const results = await Promise.all([
      store.getState().patchSettings({ folderName: 'A' }),
      store.getState().patchSettings({ folderName: 'B' }),
      store.getState().patchSettings({ folderName: 'C', zipAll: true }),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(store.getState().settings).toMatchObject({ folderName: 'C', zipAll: true });
    expect(platform.read('local', LOCAL.settings)).toMatchObject({ folderName: 'C', zipAll: true });
  });

  it('a change from outside while a patch is on its way is not lost: it shows once the patch is done', async () => {
    const platform = createMockPlatform({ scenario: 'idle' });
    const send = platform.sendMessage.bind(platform);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    platform.sendMessage = (async (message) => {
      if (message.type === 'settings/patch') await gate;
      return send(message);
    }) as typeof platform.sendMessage;
    const store = createPopupStore(platform, { pollMs: 600_000 });
    stops.push(store.getState().start());
    await flush();
    const done = store.getState().patchSettings({ showButtons: false });
    platform.write('local', { [LOCAL.settings]: { ...(platform.read('local', LOCAL.settings) as object), notifyOnComplete: false } });
    await flush();
    expect(store.getState().settings.notifyOnComplete).toBe(true); // not applied half-way: the screen does not flicker back and forth
    release();
    await done;
    await flush();
    expect(store.getState().settings).toMatchObject({ showButtons: false, notifyOnComplete: false });
  });
});

describe('actions', () => {
  it('startJob / cancelJob / removeItem / clearQueue / saveItem / rerunHistory / clearHistory / showDownload / openDiscord send their messages', async () => {
    const { platform, store } = await started('idle');
    const state = store.getState();
    const [first] = store.getState().queue;
    expect(await state.saveItem({ ...first, settings: null })).toBe(true);
    expect(await state.removeItem(first.key)).toBe(true);
    expect(await state.showDownload(5)).toBe(true);
    expect(await state.openDiscord()).toBe(true);
    expect(await state.clearHistory()).toBe(true);
    expect(await state.clearQueue()).toBe(true);
    expect(platform.sent.map((message) => message.type).filter((type) => type !== 'status/get')).toEqual(['queue/upsert', 'queue/remove', 'downloads/show', 'discord/open', 'history/clear', 'queue/clear']);
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().history).toEqual([]);
  });

  it('an action that is refused returns false and sets the notice; the next action clears it', async () => {
    const { platform, store } = await started('idle');
    platform.failNext('queue/remove', 'busy');
    expect(await store.getState().removeItem('1')).toBe(false);
    const first = store.getState().notice!;
    expect(first.code).toBe('busy');
    platform.failNext('queue/remove', 'busy');
    await store.getState().removeItem('1');
    expect(store.getState().notice!.seq).toBeGreaterThan(first.seq); // the same message is announced again
    expect(await store.getState().removeItem('nothing')).toBe(true);
    expect(store.getState().notice).toBeNull();
    store.setState({ notice: { code: 'empty', seq: 99 } });
    store.getState().dismissNotice();
    expect(store.getState().notice).toBeNull();
  });

  it('startJob: the job shows up without waiting for the next poll, and a second start while the first is on its way is ignored', async () => {
    const { platform, store } = await started('idle');
    const first = store.getState().startJob('all');
    const second = store.getState().startJob('all');
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    await flush();
    expect(platform.sent.filter((message) => message.type === 'job/start')).toHaveLength(1);
    expect(store.getState().job?.state).toBe('running');
    expect(store.getState().notice).toBeNull();
  });

  it('cancelJob keeps "cancelling" until the job has stopped, and drops it when the cancel is refused', async () => {
    const { platform, store } = await started('running');
    expect(store.getState().cancelling).toBe(false);
    platform.failNext('job/cancel', 'unknown');
    expect(await store.getState().cancelJob()).toBe(false);
    expect(store.getState().cancelling).toBe(false);
    expect(await store.getState().cancelJob()).toBe(true);
    await flush();
    expect(store.getState().job?.state).toBe('cancelled');
    expect(store.getState().cancelling).toBe(false);
  });

  it('rerunHistory starts a job; with one already running it is refused', async () => {
    const { store } = await started('idle');
    const id = store.getState().history[0].id;
    expect(await store.getState().rerunHistory(id)).toBe(true);
    await flush();
    expect(isJobActive(store.getState().job)).toBe(true);
    expect(await store.getState().rerunHistory(id)).toBe(false);
    expect(store.getState().notice?.code).toBe('busy');
  });
});

describe('the summary of a job that ended while the popup was open', () => {
  const ending = (patch: Partial<JobState>): JobState => ({ ...sampleRunningJob(Date.now()), state: 'done', finishedAt: Date.now(), ...patch });

  it('is set when the same job turns from running to over, and cleared by a new job', async () => {
    const { platform, store } = await started('running');
    expect(store.getState().justFinished).toBeNull();
    platform.write('session', { [SESSION.job]: ending({}) });
    await flush();
    expect(store.getState().justFinished?.state).toBe('done');
    store.getState().dismissFinished();
    expect(store.getState().justFinished).toBeNull();
    platform.write('session', { [SESSION.job]: ending({}) });
    await flush();
    expect(store.getState().justFinished).toBeNull(); // not running before: not a transition
    platform.write('session', { [SESSION.job]: { ...sampleRunningJob(Date.now()), jobId: 'next' } });
    await flush();
    expect(store.getState().justFinished).toBeNull();
  });

  it('is not set for a job that was over when the popup opened, nor for a different job', async () => {
    const { store } = await started('idle');
    expect(store.getState().justFinished).toBeNull();
    const running = await started('running');
    running.platform.write('session', { [SESSION.job]: ending({ jobId: 'another job' }) });
    await flush();
    expect(running.store.getState().justFinished).toBeNull();
  });
});

describe('helpers', () => {
  it('isJobActive: running and paused', () => {
    const base = sampleRunningJob(0);
    expect(isJobActive(null)).toBe(false);
    expect(isJobActive(base)).toBe(true);
    expect(isJobActive({ ...base, state: 'paused' })).toBe(true);
    for (const state of ['done', 'cancelled', 'failed'] as const) expect(isJobActive({ ...base, state })).toBe(false);
  });

  it('activeAccountOf: the live account, else the last one', () => {
    expect(activeAccountOf({ account: MOCK_ACCOUNT, lastAccount: SECOND_ACCOUNT })).toBe(MOCK_ACCOUNT);
    expect(activeAccountOf({ account: null, lastAccount: SECOND_ACCOUNT })).toBe(SECOND_ACCOUNT);
    expect(activeAccountOf({ account: null, lastAccount: null })).toBeNull();
  });
});

describe('the queue tree state (docs/PLAN.md §5.2: LOCAL.groups, LOCAL.groupSettings, LOCAL.uiExpanded)', () => {
  const ACCOUNT = MOCK_ACCOUNT.id;
  const S1 = MOCK_GUILDS.sample.id;
  const S2 = MOCK_GUILDS.study.id;
  const keyOf = (target: { channelId: string }): string => target.channelId;

  it('start() reads the groups, their settings and the open groups', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    platform.write('local', { [LOCAL.uiExpanded]: [S1] });
    const store = createPopupStore(platform);
    stops.push(store.getState().start());
    await flush();
    const state = store.getState();
    expect(Object.keys(state.groups)).toContain(S1);
    expect(state.groups[S1]).toMatchObject({ kind: 'guild', name: 'Sample Server' });
    expect(Object.keys(state.groupSettings)).toEqual([S2]);
    expect(state.expanded).toEqual([S1]);
  });

  it('without anything stored: no groups, no settings, everything collapsed', async () => {
    const { store } = await started('idle');
    expect(store.getState()).toMatchObject({ groups: {}, groupSettings: {}, expanded: [] });
  });

  it('asks only for keys the popup may read, among them the new ones', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const read: string[] = [];
    const getStorage = platform.getStorage.bind(platform);
    platform.getStorage = async (area, keys) => {
      read.push(...keys);
      return getStorage(area, keys);
    };
    const store = createPopupStore(platform);
    stops.push(store.getState().start());
    await flush();
    expect(read).toEqual(expect.arrayContaining([LOCAL.groups(ACCOUNT), LOCAL.groupSettings(ACCOUNT), LOCAL.uiExpanded]));
    expect(read).not.toContain(SESSION.token);
    expect(read).not.toContain(SESSION.tokenCapturedAt);
  });

  it('malformed data in storage is ignored instead of breaking the popup', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    platform.write('local', {
      [LOCAL.groups(ACCOUNT)]: { junk: 'x', [S1]: { kind: 'guild', guildId: S1, channelIds: ['1', 7], updatedAt: 'x', name: 3 }, bad: { kind: 'nope' } },
      [LOCAL.groupSettings(ACCOUNT)]: { [S2]: 'loud', [S1]: { count: 'many', format: 'md' } },
      [LOCAL.uiExpanded]: ['a', 5, null, 'a', ''],
    });
    const store = createPopupStore(platform);
    stops.push(store.getState().start());
    await flush();
    const state = store.getState();
    expect(Object.keys(state.groups)).toEqual([S1]);
    expect(state.groups[S1]).toEqual({ kind: 'guild', guildId: S1, channelIds: ['1'], updatedAt: 0, name: null });
    expect(Object.keys(state.groupSettings)).toEqual([S1]);
    expect(state.groupSettings[S1]).toEqual({ ...DEFAULT_EXPORT_SETTINGS, format: 'md', content: { ...DEFAULT_EXPORT_SETTINGS.content } });
    expect(state.expanded).toEqual(['a']);

    platform.write('local', { [LOCAL.groups(ACCOUNT)]: 'junk', [LOCAL.groupSettings(ACCOUNT)]: [1, 2], [LOCAL.uiExpanded]: { a: 1 } });
    await flush();
    expect(store.getState()).toMatchObject({ groups: {}, groupSettings: {}, expanded: [] });
  });

  it('follows changes made elsewhere (the background records a group, the settings change, another popup opens a group)', async () => {
    const { platform, store } = await started('idle');
    platform.write('local', { [LOCAL.groups(ACCOUNT)]: { g: { kind: 'guild', guildId: 'g', channelIds: ['1'], updatedAt: 1 } } });
    platform.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { g: DEFAULT_EXPORT_SETTINGS } });
    platform.write('local', { [LOCAL.uiExpanded]: ['g'] });
    await flush();
    expect(Object.keys(store.getState().groups)).toEqual(['g']);
    expect(Object.keys(store.getState().groupSettings)).toEqual(['g']);
    expect(store.getState().expanded).toEqual(['g']);
  });

  it('the groups of another account do not show up, and they are read again when the account changes', async () => {
    const { platform, store } = await started('tree');
    platform.write('local', {
      [LOCAL.groups(SECOND_ACCOUNT.id)]: { x: { kind: 'guild', guildId: 'x', channelIds: [], updatedAt: 1 } },
      [LOCAL.queue(SECOND_ACCOUNT.id)]: secondQueue(),
      [LOCAL.history(SECOND_ACCOUNT.id)]: [],
    });
    await flush();
    expect(Object.keys(store.getState().groups)).toContain(S1); // not touched by the other account's data
    platform.write('session', { [SESSION.account]: SECOND_ACCOUNT });
    await flush();
    expect(Object.keys(store.getState().groups)).toEqual(['x']);
    expect(store.getState().groupSettings).toEqual({});
  });

  describe('toggleGroup: the open groups are kept in LOCAL.uiExpanded, written by the popup itself', () => {
    it('opens at once (no waiting for storage), writes the list, and closing takes the id out again', async () => {
      const { platform, store } = await started('tree');
      store.getState().toggleGroup(S1);
      expect(store.getState().expanded).toEqual([S1]);
      await flush();
      expect(platform.read('local', LOCAL.uiExpanded)).toEqual([S1]);
      store.getState().toggleGroup(MOCK_CATEGORIES.study.id);
      await flush();
      expect(platform.read('local', LOCAL.uiExpanded)).toEqual([S1, MOCK_CATEGORIES.study.id]);
      store.getState().toggleGroup(S1);
      await flush();
      expect(store.getState().expanded).toEqual([MOCK_CATEGORIES.study.id]);
      expect(platform.read('local', LOCAL.uiExpanded)).toEqual([MOCK_CATEGORIES.study.id]);
    });

    it('sends no message to the background: it is a preference of the popup', async () => {
      const { platform, store } = await started('tree');
      const before = platform.sent.filter((message) => message.type !== 'status/get').length;
      store.getState().toggleGroup(S1);
      await flush();
      expect(platform.sent.filter((message) => message.type !== 'status/get')).toHaveLength(before);
    });

    it('writes nothing but that key (the platform would refuse anything else)', async () => {
      const { platform, store } = await started('tree');
      const writes: string[][] = [];
      const setStorage = platform.setStorage.bind(platform);
      platform.setStorage = async (area, items) => {
        writes.push([area, ...Object.keys(items)]);
        return setStorage(area, items);
      };
      store.getState().toggleGroup(S1);
      await flush();
      expect(writes).toEqual([['local', LOCAL.uiExpanded]]);
    });

    it('does not keep ids of servers and categories that have nothing in the list (a closed-then-forgotten group would pile up)', async () => {
      const { platform, store } = await started('tree');
      platform.write('local', { [LOCAL.uiExpanded]: ['long-gone', S1] });
      await flush();
      store.getState().toggleGroup(MOCK_CATEGORIES.study.id);
      await flush();
      expect(platform.read('local', LOCAL.uiExpanded)).toEqual([S1, MOCK_CATEGORIES.study.id]);
    });

    it('a group of a one-line server or category is remembered too (it may open again when a second chat is added)', async () => {
      const { platform, store } = await started('tree');
      store.getState().toggleGroup(MOCK_GUILDS.book.id);
      await flush();
      expect(platform.read('local', LOCAL.uiExpanded)).toEqual([MOCK_GUILDS.book.id]);
    });

    it('a write that fails leaves the state as the user set it (no error, no notice)', async () => {
      const { platform, store } = await started('tree');
      platform.setStorage = async () => {
        throw new Error('quota');
      };
      store.getState().toggleGroup(S1);
      await flush();
      expect(store.getState().expanded).toEqual([S1]);
      expect(store.getState().notice).toBeNull();
    });

    it('quick clicks keep every one of them: the echo of the first write does not undo the second', async () => {
      const { platform, store } = await started('tree');
      store.getState().toggleGroup(S1);
      store.getState().toggleGroup(MOCK_CATEGORIES.study.id);
      store.getState().toggleGroup(MOCK_GUILDS.study.id);
      await flush();
      expect(store.getState().expanded).toEqual([S1, MOCK_CATEGORIES.study.id, MOCK_GUILDS.study.id]);
      expect(platform.read('local', LOCAL.uiExpanded)).toEqual([S1, MOCK_CATEGORIES.study.id, MOCK_GUILDS.study.id]);
    });

    it('a second popup (or window) that changes the open groups is followed', async () => {
      const { platform, store } = await started('tree');
      platform.write('local', { [LOCAL.uiExpanded]: [S2] });
      await flush();
      expect(store.getState().expanded).toEqual([S2]);
    });
  });

  describe('removeMany (✕ of a server or category)', () => {
    it('sends queue/removeMany with the keys, then the list is read again', async () => {
      const { platform, store } = await started('tree');
      const keys = [keyOf(TREE_TARGETS.welcome), keyOf(TREE_TARGETS.general)];
      expect(await store.getState().removeMany(keys)).toBe(true);
      expect(platform.sent.filter((message) => message.type === 'queue/removeMany')).toEqual([{ to: 'bg', type: 'queue/removeMany', keys }]);
      expect(store.getState().queue.map((item) => item.key)).not.toContain(keys[0]);
      expect(store.getState().queue.map((item) => item.key)).not.toContain(keys[1]);
    });

    it('a refusal becomes the inline notice and the list is as it was', async () => {
      const { platform, store } = await started('tree');
      platform.failNext('queue/removeMany', 'unknown', 'storage is full');
      const before = store.getState().queue.length;
      expect(await store.getState().removeMany([keyOf(TREE_TARGETS.welcome)])).toBe(false);
      expect(store.getState().notice).toMatchObject({ code: 'unknown', message: 'storage is full' });
      expect(store.getState().queue).toHaveLength(before);
    });

    it('the group settings of an emptied group are gone from the state (the background pruned them)', async () => {
      const { store } = await started('tree');
      const keys = store.getState().queue.filter((item) => item.target.guildId === S2).map((item) => item.key);
      await store.getState().removeMany(keys);
      expect(store.getState().groupSettings).toEqual({});
    });
  });

  describe('saveGroupSettings (the save and the revert of a server or category)', () => {
    const settings = { ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, count: 12 };

    it('sends queue/setGroupSettings and reads the list and the settings again', async () => {
      const { platform, store } = await started('tree');
      expect(await store.getState().saveGroupSettings('guild', S1, S1, settings)).toBe(true);
      expect(platform.sent.filter((message) => message.type === 'queue/setGroupSettings')).toEqual([
        { to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S1, groupId: S1, settings },
      ]);
      expect(store.getState().groupSettings[S1]?.count).toBe(12);
      expect(store.getState().queue.find((item) => item.key === keyOf(TREE_TARGETS.questions))?.settings).toBeNull(); // the own settings below were cleared
    });

    it('settings null reverts: the settings of the group go, the ones of the chats stay', async () => {
      const { platform, store } = await started('tree');
      expect(await store.getState().saveGroupSettings('guild', S2, S2, null)).toBe(true);
      expect(platform.sent.filter((message) => message.type === 'queue/setGroupSettings')).toEqual([
        { to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S2, groupId: S2, settings: null },
      ]);
      expect(store.getState().groupSettings[S2]).toBeUndefined();
      expect(store.getState().queue.find((item) => item.key === keyOf(TREE_TARGETS.math))?.settings).not.toBeNull();
    });

    it('sends a copy of the settings', async () => {
      const { platform, store } = await started('tree');
      const mine = { ...settings, content: { ...settings.content } };
      const sending = store.getState().saveGroupSettings('category', S1, MOCK_CATEGORIES.study.id, mine);
      mine.count = 999;
      mine.content.includeBots = false;
      await sending;
      const message = platform.sent.find((entry) => entry.type === 'queue/setGroupSettings');
      expect(message).toMatchObject({ settings: { count: 12, content: { includeBots: true } } });
    });

    it('a refusal becomes the inline notice and nothing changes', async () => {
      const { platform, store } = await started('tree');
      platform.failNext('queue/setGroupSettings', 'empty');
      expect(await store.getState().saveGroupSettings('guild', S1, S1, settings)).toBe(false);
      expect(store.getState().notice?.code).toBe('empty');
      expect(store.getState().groupSettings[S1]).toBeUndefined();
    });
  });
});
