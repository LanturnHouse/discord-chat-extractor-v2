/**
 * The offscreen entry (src/offscreen/index.ts): it wires the host to chrome.runtime with the real download engine. The Discord API
 * is a stubbed global `fetch`; everything else (host, engine, client, library) is the real thing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_ID, DM_CHANNEL, TOKEN, dmTarget, exportSettings } from '../background/helpers';
import { msg } from '../lib/export/fakeClient';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

type Listener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => unknown;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Loads the entry against a fake chrome.runtime; `answer` is what the background says to each message. */
async function boot(answer: (message: Record<string, unknown>) => unknown = () => ({ ok: true })) {
  vi.resetModules();
  const sent: Array<Record<string, unknown>> = [];
  const listeners: Listener[] = [];
  vi.stubGlobal('chrome', {
    runtime: {
      id: EXTENSION_ID,
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        sent.push(message);
        return answer(message);
      }),
      onMessage: { addListener: (listener: Listener) => void listeners.push(listener) },
    },
  });
  await import('@/offscreen/index');
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const run = (job: Record<string, unknown>): unknown => {
    let response: unknown;
    listeners[0]({ to: 'offscreen', type: 'engine/run', job }, { id: EXTENSION_ID }, (value) => void (response = value));
    return response;
  };
  return { sent, listeners, run };
}

const job = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'j1',
  accountId: ACCOUNT_ID,
  authorization: TOKEN,
  items: [],
  settings: { common: exportSettings(), zipAll: false, folderName: 'Discord Export', dateInFileName: true, timeZone: 'UTC', language: 'en' },
  lastExported: {},
  locale: 'en',
  timeZone: 'UTC',
  ...overrides,
});

describe('src/offscreen/index.ts', () => {
  it('announces itself to the background and listens for one thing', async () => {
    const { sent, listeners } = await boot();
    expect(listeners).toHaveLength(1);
    expect(sent).toEqual([{ to: 'bg', type: 'engine/ready' }]);
  });

  it('runs a job with the real engine: a job without chats is acknowledged, reported and finished done', async () => {
    const { sent, run } = await boot();
    expect(run(job())).toEqual({ ok: true });
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ to: 'bg', type: 'engine/finished', jobId: 'j1', state: 'done' }));
    const progress = sent.filter((message) => message.type === 'engine/progress');
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(sent.some((message) => message.type === 'engine/itemDone')).toBe(false);
  });

  it('exports a chat end to end: the API calls carry the authorization, the file is saved through the background, the entry is reported', async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; credentials: RequestCredentials | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: { ...(init?.headers as Record<string, string>) }, credentials: init?.credentials });
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('/messages')) return json([msg(2, 'second', {}, DM_CHANNEL), msg(1, 'first', {}, DM_CHANNEL)]);
        return json({ id: DM_CHANNEL, type: 1, recipients: [{ id: '1000', username: 'friend', global_name: 'Friend' }] });
      }),
    );
    const { sent, run } = await boot((message) => (message.type === 'engine/saveBlob' ? { ok: true, data: { downloadId: 7 } } : { ok: true }));

    expect(run(job({ items: [{ key: DM_CHANNEL, target: dmTarget(DM_CHANNEL), settings: exportSettings({ count: null, format: 'txt' }) }] }))).toEqual({ ok: true });
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'engine/finished', state: 'done' }));

    const save = sent.find((message) => message.type === 'engine/saveBlob') as Record<string, unknown>;
    expect(save).toMatchObject({ to: 'bg', jobId: 'j1', itemKey: DM_CHANNEL });
    expect(String(save.url)).toMatch(/^blob:/);
    expect(String(save.filename)).toMatch(/^Discord Export\/DM - Friend \(\d{4}-\d{2}-\d{2}\)\.txt$/);

    const done = sent.find((message) => message.type === 'engine/itemDone') as { entry: Record<string, unknown>; lastMessageId: string | null };
    expect(done.entry).toMatchObject({ accountId: ACCOUNT_ID, status: 'done', messageCount: 2, files: [{ filename: save.filename, downloadId: 7 }], error: null });
    expect(done.lastMessageId).toBe(msg(2, '').id);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([`/api/v9/channels/${DM_CHANNEL}`, `/api/v9/channels/${DM_CHANNEL}/messages`]);
    expect(requests.every((request) => request.headers.Authorization === TOKEN && request.credentials === 'omit')).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(TOKEN); // the value goes into the header of the API requests and nowhere else
  });

  it('cancelling through the host stops the real engine and finishes the job cancelled', async () => {
    // an answer that never comes, until the request is aborted (as fetch does)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))),
      ),
    );
    const { sent, listeners, run } = await boot();
    expect(run(job({ items: [{ key: DM_CHANNEL, target: dmTarget(DM_CHANNEL), settings: exportSettings({ format: 'txt' }) }] }))).toEqual({ ok: true });
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'engine/progress')).toBe(true));
    let response: unknown;
    listeners[0]({ to: 'offscreen', type: 'engine/cancel', jobId: 'j1' }, { id: EXTENSION_ID }, (value) => void (response = value));
    expect(response).toEqual({ ok: true });
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ to: 'bg', type: 'engine/finished', jobId: 'j1', state: 'cancelled' }), { timeout: 5000 });
    expect(sent.some((message) => message.type === 'engine/itemDone')).toBe(false);
  });
});
