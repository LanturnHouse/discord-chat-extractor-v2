/**
 * The offscreen host (src/offscreen/host.ts): the messaging, blob URL and keep-alive half of the download engine. Everything
 * it touches (chrome.runtime, URL, timers) is faked here; the whole background <-> offscreen flow is tested in
 * tests/background/jobs.*.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineJob, JobState } from '@/shared';
import { KEEPALIVE_INTERVAL_MS, startOffscreenHost } from '@/offscreen/host';
import type { HostRuntime } from '@/offscreen/host';
import { EngineSaveError } from '@/offscreen/runner';
import type { EngineIO, EngineRunner } from '@/offscreen/runner';
import { guildTarget, exportSettings, historyEntry, TOKEN, ACCOUNT_ID } from '../background/helpers';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void;

/** A fake chrome.runtime: records what the host sends (and answers as the test says) and lets the test deliver messages to it. */
function createRuntime(answer: (message: Record<string, unknown>) => unknown | Promise<unknown> = () => ({ ok: true })) {
  const listeners: Listener[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const runtime: HostRuntime = {
    id: EXTENSION_ID,
    sendMessage: vi.fn(async (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return answer(message as Record<string, unknown>);
    }),
    onMessage: { addListener: (listener) => void listeners.push(listener) },
  };
  /** Delivers a message like Chrome does and returns what the listener answered (synchronously), or `undefined`. */
  function deliver(message: unknown, sender: chrome.runtime.MessageSender = { id: EXTENSION_ID }): { returned: unknown; response: unknown } {
    let response: unknown;
    let returned: unknown = false;
    for (const listener of listeners) returned = listener(message, sender, (value) => void (response = value));
    return { returned, response };
  }
  return { runtime, listeners, sent, deliver };
}

function engineJob(overrides: Partial<EngineJob> = {}): EngineJob {
  return {
    jobId: 'job-1',
    accountId: ACCOUNT_ID,
    authorization: TOKEN,
    items: [{ key: '400000000000000001', target: guildTarget(), settings: exportSettings() }],
    settings: {
      common: exportSettings(),
      showButtons: true,
      showQueuedIndicator: false,
      zipAll: false,
      folderName: 'Discord Export',
      dateInFileName: true,
      timeZone: 'auto',
      notifyOnComplete: true,
      language: 'en',
      consentAt: 1,
    },
    lastExported: {},
    locale: 'en',
    timeZone: 'UTC',
    ...overrides,
  };
}

/** A runner the test drives by hand. */
function manualRunner() {
  const calls: { job: EngineJob; io: EngineIO }[] = [];
  const cancelled: string[] = [];
  let release: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const runner: EngineRunner = {
    run(job, io) {
      calls.push({ job, io });
      return new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    },
    cancel: (jobId) => void cancelled.push(jobId),
  };
  return { runner, calls, cancelled, finish: () => release(), crash: (error: Error) => fail(error) };
}

const snapshotOf = (job: EngineJob): JobState => ({
  jobId: job.jobId,
  accountId: job.accountId,
  startedAt: 1,
  finishedAt: null,
  state: 'running',
  pausedReason: null,
  zip: false,
  items: [],
});

let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  vi.useRealTimers();
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('start-up', () => {
  it('registers its listener and then announces itself with engine/ready', async () => {
    const { runtime, listeners, sent } = createRuntime();
    startOffscreenHost({ runtime, runner: manualRunner().runner });
    expect(listeners).toHaveLength(1);
    await flush();
    expect(sent).toEqual([{ to: 'bg', type: 'engine/ready' }]);
  });

  it('is not troubled by a worker that cannot be reached', async () => {
    const { runtime } = createRuntime(() => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    expect(() => startOffscreenHost({ runtime, runner: manualRunner().runner })).not.toThrow();
    await flush();
  });
});

describe('messages it receives', () => {
  it.each([
    ['for the background', { to: 'bg', type: 'engine/run', job: engineJob() }],
    ['without a target', { type: 'engine/run', job: engineJob() }],
    ['for the content script', { to: 'content', type: 'x' }],
    ['not an object', 'engine/run'],
    ['null', null],
    ['an unknown type', { to: 'offscreen', type: 'engine/explode' }],
  ])('ignores a message %s (no answer)', async (_label, message) => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls } = manualRunner();
    startOffscreenHost({ runtime, runner });
    const { returned, response } = deliver(message);
    expect(returned).toBe(false);
    expect(response).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('ignores a message from another extension', () => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls } = manualRunner();
    startOffscreenHost({ runtime, runner });
    const { response } = deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() }, { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
    expect(response).toBeUndefined();
    expect(calls).toEqual([]);
    expect(deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() }, {}).response).toBeUndefined();
  });
});

describe('engine/run', () => {
  it('acknowledges at once and gives the job and an io to the runner', () => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls } = manualRunner();
    startOffscreenHost({ runtime, runner });
    const job = engineJob();
    const { response } = deliver({ to: 'offscreen', type: 'engine/run', job });
    expect(response).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].job).toEqual(job);
    expect(calls[0].io.signal.aborted).toBe(false);
  });

  it.each([
    ['no job', {}],
    ['a job without an id', { job: { ...engineJob(), jobId: undefined } }],
    ['a job without authorization', { job: { ...engineJob(), authorization: undefined } }],
    ['a job without items', { job: { ...engineJob(), items: 'x' } }],
    ['a job without settings', { job: { ...engineJob(), settings: undefined } }],
    ['a string', { job: 'job' }],
  ])('refuses %s', (_label, extra) => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls } = manualRunner();
    startOffscreenHost({ runtime, runner });
    expect(deliver({ to: 'offscreen', type: 'engine/run', ...extra }).response).toEqual({ ok: false, error: 'invalid', message: 'engine/run needs a job' });
    expect(calls).toEqual([]);
  });

  it('runs one job at a time: a second engine/run is "busy"', () => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls } = manualRunner();
    startOffscreenHost({ runtime, runner });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    expect(deliver({ to: 'offscreen', type: 'engine/run', job: engineJob({ jobId: 'job-2' }) }).response).toMatchObject({ ok: false, error: 'busy' });
    expect(calls).toHaveLength(1);
  });

  it('accepts the next job as soon as the runner reports finished, even before its promise settles', async () => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls } = manualRunner();
    startOffscreenHost({ runtime, runner });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await calls[0].io.finished('job-1', 'done');
    expect(deliver({ to: 'offscreen', type: 'engine/run', job: engineJob({ jobId: 'job-2' }) }).response).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('accepts the next job after the runner returns', async () => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls, finish } = manualRunner();
    startOffscreenHost({ runtime, runner });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await calls[0].io.finished('job-1', 'done');
    finish();
    await flush();
    expect(deliver({ to: 'offscreen', type: 'engine/run', job: engineJob({ jobId: 'job-2' }) }).response).toEqual({ ok: true });
  });
});

describe('when a runner ends without reporting', () => {
  it('reports "failed" for a runner that just returns', async () => {
    const { runtime, deliver, sent } = createRuntime();
    const { runner, finish } = manualRunner();
    startOffscreenHost({ runtime, runner });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    finish();
    await flush();
    await flush();
    expect(sent.filter((message) => message.type === 'engine/finished')).toEqual([{ to: 'bg', type: 'engine/finished', jobId: 'job-1', state: 'failed' }]);
  });

  it('reports "failed" for a runner that throws', async () => {
    const { runtime, deliver, sent } = createRuntime();
    const { runner, crash } = manualRunner();
    startOffscreenHost({ runtime, runner });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    crash(new Error(`boom with ${TOKEN}`));
    await flush();
    await flush();
    expect(sent.filter((message) => message.type === 'engine/finished')).toEqual([{ to: 'bg', type: 'engine/finished', jobId: 'job-1', state: 'failed' }]);
    expect(JSON.stringify(sent)).not.toContain('boom'); // the error text goes nowhere
  });

  it('a runner that throws synchronously is handled the same way', async () => {
    const { runtime, deliver, sent } = createRuntime();
    startOffscreenHost({
      runtime,
      runner: {
        run: () => {
          throw new Error('sync boom');
        },
        cancel: () => undefined,
      },
    });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await flush();
    await flush();
    expect(sent.filter((message) => message.type === 'engine/finished')).toHaveLength(1);
  });

  it('sends exactly one finished message when the runner reports and then returns', async () => {
    const { runtime, deliver, sent } = createRuntime();
    const { runner, calls, finish } = manualRunner();
    startOffscreenHost({ runtime, runner });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await calls[0].io.finished('job-1', 'cancelled');
    finish();
    await flush();
    await flush();
    expect(sent.filter((message) => message.type === 'engine/finished')).toEqual([{ to: 'bg', type: 'engine/finished', jobId: 'job-1', state: 'cancelled' }]);
  });
});

describe('engine/cancel', () => {
  it('tells the runner and aborts the signal for the running job', () => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls, cancelled } = manualRunner();
    startOffscreenHost({ runtime, runner });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    expect(deliver({ to: 'offscreen', type: 'engine/cancel', jobId: 'job-1' }).response).toEqual({ ok: true });
    expect(cancelled).toEqual(['job-1']);
    expect(calls[0].io.signal.aborted).toBe(true);
  });

  it('ignores a job that is not running (and still answers)', () => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls, cancelled } = manualRunner();
    startOffscreenHost({ runtime, runner });
    expect(deliver({ to: 'offscreen', type: 'engine/cancel', jobId: 'job-1' }).response).toEqual({ ok: true });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    deliver({ to: 'offscreen', type: 'engine/cancel', jobId: 'another-job' });
    deliver({ to: 'offscreen', type: 'engine/cancel' });
    expect(cancelled).toEqual([]);
    expect(calls[0].io.signal.aborted).toBe(false);
  });
});

describe('engine/revoke', () => {
  it('frees blob URLs, and only blob URLs', () => {
    const revokeObjectURL = vi.fn();
    const { runtime, deliver } = createRuntime();
    startOffscreenHost({ runtime, runner: manualRunner().runner, revokeObjectURL });
    expect(deliver({ to: 'offscreen', type: 'engine/revoke', url: 'blob:chrome-extension://x/1' }).response).toEqual({ ok: true });
    deliver({ to: 'offscreen', type: 'engine/revoke', url: 'https://discord.com/' });
    deliver({ to: 'offscreen', type: 'engine/revoke', url: 5 });
    deliver({ to: 'offscreen', type: 'engine/revoke' });
    expect(revokeObjectURL.mock.calls).toEqual([['blob:chrome-extension://x/1']]);
  });
});

describe('keep-alive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sends engine/keepalive every 20 s while a job runs, and stops when it is finished', async () => {
    expect(KEEPALIVE_INTERVAL_MS).toBe(20_000);
    const { runtime, deliver, sent } = createRuntime();
    const { runner, calls } = manualRunner();
    startOffscreenHost({ runtime, runner });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.filter((message) => message.type === 'engine/keepalive')).toEqual([]); // nothing runs: nothing to keep alive
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(sent.filter((message) => message.type === 'engine/keepalive')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent.filter((message) => message.type === 'engine/keepalive')).toEqual([
      { to: 'bg', type: 'engine/keepalive', jobId: 'job-1' },
      { to: 'bg', type: 'engine/keepalive', jobId: 'job-1' },
    ]);
    await calls[0].io.finished('job-1', 'done');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(sent.filter((message) => message.type === 'engine/keepalive')).toHaveLength(2);
  });

  it('honours a custom interval and stops on dispose', async () => {
    const { runtime, deliver, sent } = createRuntime();
    const host = startOffscreenHost({ runtime, runner: manualRunner().runner, keepaliveMs: 1000 });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await vi.advanceTimersByTimeAsync(3500);
    expect(sent.filter((message) => message.type === 'engine/keepalive')).toHaveLength(3);
    host.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.filter((message) => message.type === 'engine/keepalive')).toHaveLength(3);
  });

  it('a failing keepalive does not matter', async () => {
    const { runtime, deliver } = createRuntime((message) => {
      if (message.type === 'engine/keepalive') throw new Error('worker not reachable');
      return { ok: true };
    });
    startOffscreenHost({ runtime, runner: manualRunner().runner, keepaliveMs: 1000 });
    deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await vi.advanceTimersByTimeAsync(3500);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1 + 3);
  });
});

describe('what the runner can send', () => {
  async function running() {
    const rt = createRuntime();
    const manual = manualRunner();
    const host = startOffscreenHost({ runtime: rt.runtime, runner: manual.runner });
    rt.deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await flush();
    rt.sent.length = 0;
    return { ...rt, ...manual, io: manual.calls[0].io, host };
  }

  it('progress, itemDone, authError and finished are messages to the background', async () => {
    const { io, sent } = await running();
    const job = snapshotOf(engineJob());
    const entry = historyEntry(guildTarget());
    await io.progress(job);
    await io.itemDone('job-1', entry, '123');
    await io.authError('job-1');
    await io.finished('job-1', 'done');
    expect(sent).toEqual([
      { to: 'bg', type: 'engine/progress', job },
      { to: 'bg', type: 'engine/itemDone', jobId: 'job-1', entry, lastMessageId: '123' },
      { to: 'bg', type: 'engine/authError', jobId: 'job-1' },
      { to: 'bg', type: 'engine/finished', jobId: 'job-1', state: 'done' },
    ]);
  });

  it('goes out one at a time, in order: a message waits until the one before it was answered', async () => {
    const release: Array<() => void> = [];
    const rt = createRuntime(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve({ ok: true }));
        }),
    );
    const manual = manualRunner();
    startOffscreenHost({ runtime: rt.runtime, runner: manual.runner });
    await flush();
    release.shift()!(); // answer engine/ready
    await flush();
    rt.deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    const { io } = manual.calls[0];
    const first = io.progress(snapshotOf(engineJob()));
    const second = io.itemDone('job-1', historyEntry(guildTarget()), null);
    const third = io.finished('job-1', 'done');
    await flush();
    expect(rt.sent.map((message) => message.type)).toEqual(['engine/ready', 'engine/progress']);
    release.shift()!();
    await first;
    await flush();
    expect(rt.sent.map((message) => message.type)).toEqual(['engine/ready', 'engine/progress', 'engine/itemDone']);
    release.shift()!();
    await second;
    await flush();
    release.shift()!();
    await third;
    expect(rt.sent.map((message) => message.type)).toEqual(['engine/ready', 'engine/progress', 'engine/itemDone', 'engine/finished']);
  });

  it('a send that fails is swallowed and the next one still goes out', async () => {
    let fail = true;
    const rt = createRuntime(() => {
      if (fail) throw new Error('worker gone');
      return { ok: true };
    });
    const manual = manualRunner();
    startOffscreenHost({ runtime: rt.runtime, runner: manual.runner });
    rt.deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await flush();
    const { io } = manual.calls[0];
    await expect(io.progress(snapshotOf(engineJob()))).resolves.toBeUndefined();
    fail = false;
    await io.authError('job-1');
    expect(rt.sent.at(-1)).toEqual({ to: 'bg', type: 'engine/authError', jobId: 'job-1' });
  });

  it('never adds the authorization to anything it sends', async () => {
    const { io, sent } = await running();
    await io.progress(snapshotOf(engineJob()));
    await io.finished('job-1', 'done');
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('saveBlob', () => {
  function setup(answer: (message: Record<string, unknown>) => unknown | Promise<unknown>) {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const rt = createRuntime((message) => (message.type === 'engine/saveBlob' ? answer(message) : { ok: true }));
    const manual = manualRunner();
    startOffscreenHost({
      runtime: rt.runtime,
      runner: manual.runner,
      createObjectURL: (blob) => {
        created.push(blob);
        return `blob:chrome-extension://${EXTENSION_ID}/uuid-${created.length}`;
      },
      revokeObjectURL: (url) => void revoked.push(url),
    });
    rt.deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    return { ...rt, created, revoked, io: manual.calls[0].io };
  }

  it('turns the blob into an object URL, asks for the download and resolves with its id; the URL stays alive for the background', async () => {
    const { io, created, revoked, sent } = setup(() => ({ ok: true, data: { downloadId: 42 } }));
    const blob = new Blob(['hello']);
    await expect(io.saveBlob('job-1', '400000000000000001', blob, 'Discord Export/a.html')).resolves.toBe(42);
    expect(created).toEqual([blob]);
    expect(sent.at(-1)).toEqual({
      to: 'bg',
      type: 'engine/saveBlob',
      jobId: 'job-1',
      itemKey: '400000000000000001',
      url: `blob:chrome-extension://${EXTENSION_ID}/uuid-1`,
      filename: 'Discord Export/a.html',
    });
    expect(revoked).toEqual([]);
  });

  it('a blob that cannot be turned into an object URL is an EngineSaveError, and nothing is sent', async () => {
    const rt = createRuntime();
    const manual = manualRunner();
    startOffscreenHost({
      runtime: rt.runtime,
      runner: manual.runner,
      createObjectURL: () => {
        throw new Error('out of memory');
      },
      revokeObjectURL: () => undefined,
    });
    rt.deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await flush();
    rt.sent.length = 0;
    await expect(manual.calls[0].io.saveBlob('job-1', null, new Blob(['x']), 'a.html')).rejects.toMatchObject({ name: 'EngineSaveError', code: 'unknown' });
    expect(rt.sent).toEqual([]);
  });

  it('allows a null item key (a ZIP of several chats)', async () => {
    const { io, sent } = setup(() => ({ ok: true, data: { downloadId: 1 } }));
    await io.saveBlob('job-1', null, new Blob(['z']), 'Discord Export/x.zip');
    expect(sent.at(-1)).toMatchObject({ itemKey: null });
  });

  it('a refusal rejects with an EngineSaveError carrying the code and message, and frees the URL itself', async () => {
    const { io, revoked } = setup(() => ({ ok: false, error: 'invalid', message: 'filename must be a relative path' }));
    const error = await io.saveBlob('job-1', null, new Blob(['x']), '../x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineSaveError);
    expect(error).toMatchObject({ name: 'EngineSaveError', code: 'invalid', message: 'filename must be a relative path' });
    expect(revoked).toEqual([`blob:chrome-extension://${EXTENSION_ID}/uuid-1`]);
  });

  it('a refusal without a message still has one', async () => {
    const { io } = setup(() => ({ ok: false, error: 'busy' }));
    await expect(io.saveBlob('job-1', null, new Blob(['x']), 'a.html')).rejects.toMatchObject({ code: 'busy', message: expect.stringMatching(/\w/) });
  });

  it('an unreachable background is an EngineSaveError "unreachable", and the URL is freed', async () => {
    const { io, revoked } = setup(() => {
      throw new Error('Could not establish connection');
    });
    await expect(io.saveBlob('job-1', null, new Blob(['x']), 'a.html')).rejects.toMatchObject({ name: 'EngineSaveError', code: 'unreachable' });
    expect(revoked).toHaveLength(1);
  });

  it('an answer that is neither ok nor an error is "unreachable" too', async () => {
    for (const answer of [undefined, null, 'ok', { ok: true }, { ok: true, data: { downloadId: 'x' } }, { ok: true, data: {} }]) {
      const { io, revoked } = setup(() => answer);
      await expect(io.saveBlob('job-1', null, new Blob(['x']), 'a.html')).rejects.toMatchObject({ code: 'unreachable' });
      expect(revoked).toHaveLength(1);
    }
  });
});

describe('saveUrl', () => {
  it('asks for the download of a URL and resolves with its id (nothing to free)', async () => {
    const rt = createRuntime((message) => (message.type === 'engine/saveUrl' ? { ok: true, data: { downloadId: 7 } } : { ok: true }));
    const manual = manualRunner();
    const revokeObjectURL = vi.fn();
    startOffscreenHost({ runtime: rt.runtime, runner: manual.runner, revokeObjectURL });
    rt.deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1';
    await expect(manual.calls[0].io.saveUrl('job-1', '400000000000000001', url, 'f/a.png')).resolves.toBe(7);
    expect(rt.sent.at(-1)).toEqual({ to: 'bg', type: 'engine/saveUrl', jobId: 'job-1', itemKey: '400000000000000001', url, filename: 'f/a.png' });
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('a refusal rejects with the background\'s code', async () => {
    const rt = createRuntime((message) => (message.type === 'engine/saveUrl' ? { ok: false, error: 'invalid', message: 'not the CDN' } : { ok: true }));
    const manual = manualRunner();
    startOffscreenHost({ runtime: rt.runtime, runner: manual.runner });
    rt.deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
    await expect(manual.calls[0].io.saveUrl('job-1', 'k', 'https://example.com/a', 'a')).rejects.toMatchObject({ code: 'invalid', message: 'not the CDN' });
  });
});

describe('dispose', () => {
  it('makes the host ignore every further message', () => {
    const { runtime, deliver } = createRuntime();
    const { runner, calls } = manualRunner();
    const host = startOffscreenHost({ runtime, runner });
    host.dispose();
    expect(deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() }).response).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('the defaults of a real offscreen document', () => {
  it('use URL.createObjectURL / URL.revokeObjectURL', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chrome-extension://x/real');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    try {
      const rt = createRuntime((message) => (message.type === 'engine/saveBlob' ? { ok: true, data: { downloadId: 3 } } : { ok: true }));
      const manual = manualRunner();
      startOffscreenHost({ runtime: rt.runtime, runner: manual.runner });
      rt.deliver({ to: 'offscreen', type: 'engine/run', job: engineJob() });
      await manual.calls[0].io.saveBlob('job-1', null, new Blob(['x']), 'a.html');
      expect(createSpy).toHaveBeenCalledTimes(1);
      rt.deliver({ to: 'offscreen', type: 'engine/revoke', url: 'blob:chrome-extension://x/real' });
      expect(revokeSpy).toHaveBeenCalledWith('blob:chrome-extension://x/real');
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });
});
