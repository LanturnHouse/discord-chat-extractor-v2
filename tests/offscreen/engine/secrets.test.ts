/**
 * The authorization value of a job lives in memory and goes into the header of the client's requests only (docs/PLAN.md §8): never
 * into a progress snapshot, a history entry, an error text, a file name, a file, the ZIP, or a request to the CDN. These tests run
 * jobs that go wrong in the ways that could leak it (errors that carry it, refused saves that echo it) and look at everything the
 * engine said and saved.
 */
import { describe, expect, it } from 'vitest';
import { DiscordApiError } from '@/lib';
import { EngineSaveError } from '@/offscreen/runner';
import {
  CHATS,
  TOKEN,
  attachmentOf,
  blobsOf,
  chatWorld,
  createHarness,
  decode,
  engineJob,
  itemDones,
  jobOf,
  resultOf,
  rowOf,
  runJob,
  scriptedExport,
  snapshots,
  unzip,
  urlsOf,
} from './kit';
import type { Call, Harness } from './kit';

/** Everything the engine said (as the background would receive it) and everything it saved, as text. */
async function everything(calls: readonly Call[]): Promise<string> {
  const parts = [JSON.stringify(calls)]; // blobs are `{}` here: their content follows
  for (const save of blobsOf(calls)) {
    if (save.filename.endsWith('.zip')) for (const bytes of Object.values(await unzip(save.blob))) parts.push(decode(bytes));
    else parts.push(await save.blob.text());
  }
  return parts.join('\n');
}

const leak = `Bearer-less value ${TOKEN} echoed back`;

async function expectNoSecret(harness: Harness, job = jobOf()): Promise<{ calls: Call[]; text: string }> {
  const calls = await runJob(harness, job);
  const text = await everything(calls);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(TOKEN.slice(0, 20));
  return { calls, text };
}

describe('the authorization value never leaves the engine', () => {
  it('a normal job: nothing carries it', async () => {
    const { calls } = await expectNoSecret(createHarness(), jobOf([0, 1, 2], { includeAttachments: true }));
    expect(calls.length).toBeGreaterThan(5);
  });

  it('a normal ZIP job: nothing carries it, not the archive either', async () => {
    const world = chatWorld([{ attachments: [['11', 'cat.png', Math.floor(Date.UTC(2026, 9, 6, 11, 59) / 1000)]] }]);
    await expectNoSecret(createHarness({ world }), jobOf([0, 1], { includeAttachments: true }, { app: { zipAll: true } }));
  });

  it('does not send it to the CDN: the requests carry no credentials and the engine asks for nothing but the URL', async () => {
    const world = chatWorld([{ attachments: [['11', 'cat.png', Math.floor(Date.UTC(2026, 9, 6, 11, 59) / 1000)]] }]);
    const harness = createHarness({ world });
    await runJob(harness, jobOf([0], { includeAttachments: true }, { app: { zipAll: true } }));
    expect(harness.fetched).toHaveLength(1);
    expect(harness.fetched[0].credentials).toBe('omit');
    expect(harness.fetched[0].url).not.toContain(TOKEN);
  });

  it('an error that carries it is redacted in the progress and the history', async () => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' ? new Error(`boom ${leak}`) : undefined) });
    const { calls } = await expectNoSecret(harness, jobOf([0]));
    expect(rowOf(calls, CHATS[0]).error).toEqual({ kind: 'unknown', message: 'boom Bearer-less value [redacted] echoed back' });
    expect(itemDones(calls)[0].error).toBe('boom Bearer-less value [redacted] echoed back');
  });

  it('an exception of the export step that carries it is redacted', async () => {
    const harness = createHarness({
      deps: {
        exportChat: scriptedExport({
          [CHATS[0]]: () => {
            throw new TypeError(`bad header ${TOKEN}`);
          },
        }),
      },
    });
    const { calls } = await expectNoSecret(harness, jobOf([0, 1]));
    expect(rowOf(calls, CHATS[0]).error?.message).toBe('bad header [redacted]');
  });

  it('a refused save that echoes it is redacted', async () => {
    const harness = createHarness({ io: { failBlob: () => true, refusal: `filename ${TOKEN} is not allowed` } });
    const { calls } = await expectNoSecret(harness, jobOf([0]));
    expect(itemDones(calls)[0].error).toBe('Could not save the file (filename [redacted] is not allowed)');
  });

  it('a refused archive that echoes it is redacted', async () => {
    const harness = createHarness({ io: { failBlob: () => true, refusal: `${TOKEN}` } });
    const { calls } = await expectNoSecret(harness, jobOf([0, 1], {}, { app: { zipAll: true } }));
    expect(itemDones(calls)[0].error).toBe('Could not save the ZIP file ([redacted])');
  });

  it('a refused attachment that echoes it leaves nothing behind (only a count)', async () => {
    const harness = createHarness({
      io: { failUrl: () => true, refusal: TOKEN },
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: [attachmentOf(0, '11', 'cat.png')] }) }) },
    });
    const { calls } = await expectNoSecret(harness, jobOf([0], { includeAttachments: true }));
    expect(itemDones(calls)[0].error).toBe('1 attachment could not be saved');
    expect(urlsOf(calls)).toEqual([]);
  });

  it('a CDN that fails with it in the message leaves nothing behind', async () => {
    const world = chatWorld([{ attachments: [['11', 'cat.png', Math.floor(Date.UTC(2026, 9, 6, 11, 59) / 1000)]] }]);
    const harness = createHarness({ world, deps: { fetch: (async () => Promise.reject(new TypeError(`failed ${TOKEN}`))) as unknown as typeof fetch } });
    const { calls } = await expectNoSecret(harness, jobOf([0], { includeAttachments: true }, { app: { zipAll: true } }));
    expect(itemDones(calls)[0].error).toBe('1 attachment could not be saved');
  });

  it('an authorization error stops the job without it appearing anywhere', async () => {
    let options: { onAuthError?: (value: string) => void } | undefined;
    const harness: Harness = createHarness({
      fail: (call) => {
        if (call.method !== 'getMessages') return undefined;
        options?.onAuthError?.(TOKEN); // the live client hands over the value that was rejected: the engine must not pass it on
        return new DiscordApiError('auth', `Unauthorized ${TOKEN}`, { status: 401 });
      },
      deps: { createClient: (opts) => ((options = opts), harness.client) },
    });
    const { calls } = await expectNoSecret(harness);
    expect(calls.filter((entry) => entry.call === 'authError')).toEqual([{ call: 'authError', jobId: 'job-1' }]);
  });

  it('a save failure of the background with a different kind of error does not change that', async () => {
    const harness = createHarness({
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0) }) },
    });
    harness.fake.io.saveBlob = async () => {
      throw new EngineSaveError('http', `the download of ${TOKEN} failed`);
    };
    const { calls } = await expectNoSecret(harness, jobOf([0]));
    expect(itemDones(calls)[0].error).toBe('Could not save the file (the download of [redacted] failed)');
  });

  it('works for a value with spaces around it (the client trims it before it sends it)', async () => {
    const padded = engineJob({ ...jobOf([0]), authorization: `  ${TOKEN}  ` });
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' ? new Error(`oops ${TOKEN}`) : undefined) });
    const calls = await runJob(harness, padded);
    expect(await everything(calls)).not.toContain(TOKEN);
  });

  it('puts the value into no progress snapshot at all, whatever the job did', async () => {
    const harness = createHarness({ world: chatWorld([{}, { messages: 250 }]), fail: (call) => (call.method === 'getMessages' && call.n === 1 ? new Error(`mid-way ${TOKEN}`) : undefined) });
    const calls = await runJob(harness, jobOf([0, 1]));
    for (const state of snapshots(calls)) expect(JSON.stringify(state)).not.toContain(TOKEN);
  });
});
