/**
 * Shared set-up of the tests of the download engine (src/offscreen/engine): a fake `EngineIO` that records everything the engine
 * tells the background (and answers saves with download ids), a job builder, a small world of chats for the library's fake client,
 * a fake CDN, and readers of what was recorded. Nothing here touches a network, and the engine's clock, sleeps and ids are injected.
 *
 * Fixtures use neutral names and made-up ids; the authorization value is the same fake one the background tests use.
 */
import { unzipSync } from 'fflate';
import { vi } from 'vitest';
import type { ChatAttachment, ChatOutput, DiscordClient, ExportChatResult, HttpTransport, LiveDiscordClientOptions, TransportRequest } from '@/lib';
import type { AppSettings, ChatTarget, EngineJob, ExportSettings, HistoryEntry, ItemProgress, JobState } from '@/shared';
import { createEngineRunner } from '@/offscreen/engine';
import type { EngineDeps } from '@/offscreen/engine';
import { EngineSaveError } from '@/offscreen/runner';
import type { EngineIO, EngineRunner } from '@/offscreen/runner';
import { ACCOUNT_ID, TOKEN, exportSettings, guildTarget } from '../../background/helpers';
import { DAY0, GUILD, GUILD_ID as WORLD_GUILD_ID, CATEGORY_ID, channel, fakeClient, msg } from '../../lib/export/fakeClient';
import type { FakeCall, FakeClient, FakeWorld, Failure } from '../../lib/export/fakeClient';

export { ACCOUNT_ID, TOKEN, exportSettings };
export { DAY0, fakeClient, msg };
export type { FakeCall, FakeClient, FakeWorld };

// ---- the clock -------------------------------------------------------------------------------------------------------------

/** 2026-10-06 12:00:00 UTC = 21:00 in Seoul: the day in every file name, "Discord Export 2026-10-06 2100.zip" in Seoul time. */
export const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
export const SEOUL = 'Asia/Seoul';

// ---- what the engine tells the background ----------------------------------------------------------------------------------

export type Call =
  | { call: 'progress'; job: JobState }
  | { call: 'saveBlob'; jobId: string; itemKey: string | null; filename: string; blob: Blob; downloadId: number }
  | { call: 'saveUrl'; jobId: string; itemKey: string; url: string; filename: string; downloadId: number }
  | { call: 'itemDone'; jobId: string; entry: HistoryEntry; lastMessageId: string | null }
  | { call: 'authError'; jobId: string }
  | { call: 'finished'; jobId: string; state: string };

export interface IoOptions {
  /** Makes `saveBlob` of this file reject (as the background refusing a save does). */
  failBlob?: (filename: string) => boolean;
  /** Makes `saveUrl` of this file reject. */
  failUrl?: (filename: string) => boolean;
  /** What the background says when it refuses a save. */
  refusal?: string;
}

export interface FakeIo {
  io: EngineIO;
  /** Every call, in order. */
  calls: Call[];
  /** Aborts `io.signal`: what `engine/cancel` does in the host. */
  abort: AbortController;
}

/** An `EngineIO` that records its calls. Download ids count up from 100. */
export function createIo(options: IoOptions = {}, abort = new AbortController()): FakeIo {
  const calls: Call[] = [];
  let nextId = 100;
  const refused = (): EngineSaveError => new EngineSaveError('invalid', options.refusal ?? 'the save was refused');
  const io: EngineIO = {
    signal: abort.signal,
    progress: async (job) => void calls.push({ call: 'progress', job }),
    saveBlob: async (jobId, itemKey, blob, filename) => {
      if (options.failBlob?.(filename) === true) throw refused();
      const downloadId = (nextId += 1);
      calls.push({ call: 'saveBlob', jobId, itemKey, filename, blob, downloadId });
      return downloadId;
    },
    saveUrl: async (jobId, itemKey, url, filename) => {
      if (options.failUrl?.(filename) === true) throw refused();
      const downloadId = (nextId += 1);
      calls.push({ call: 'saveUrl', jobId, itemKey, url, filename, downloadId });
      return downloadId;
    },
    itemDone: async (jobId, entry, lastMessageId) => void calls.push({ call: 'itemDone', jobId, entry, lastMessageId }),
    authError: async (jobId) => void calls.push({ call: 'authError', jobId }),
    finished: async (jobId, state) => void calls.push({ call: 'finished', jobId, state }),
  };
  return { io, calls, abort };
}

type Of<K extends Call['call']> = Extract<Call, { call: K }>;
export const callsOf = <K extends Call['call']>(calls: readonly Call[], kind: K): Array<Of<K>> => calls.filter((entry): entry is Of<K> => entry.call === kind);
export const snapshots = (calls: readonly Call[]): JobState[] => callsOf(calls, 'progress').map((entry) => entry.job);
export const lastSnapshot = (calls: readonly Call[]): JobState => snapshots(calls).at(-1) as JobState;
export const itemDones = (calls: readonly Call[]): HistoryEntry[] => callsOf(calls, 'itemDone').map((entry) => entry.entry);
export const blobsOf = (calls: readonly Call[]): Array<Of<'saveBlob'>> => callsOf(calls, 'saveBlob');
export const urlsOf = (calls: readonly Call[]): Array<Of<'saveUrl'>> => callsOf(calls, 'saveUrl');
export const finishedOf = (calls: readonly Call[]): string[] => callsOf(calls, 'finished').map((entry) => entry.state);
/** The status of every chat in the last snapshot. */
export const statusesOf = (calls: readonly Call[]): string[] => lastSnapshot(calls).items.map((row) => row.status);
export const rowOf = (calls: readonly Call[], key: string): ItemProgress => lastSnapshot(calls).items.find((row) => row.key === key) as ItemProgress;

export const textOfBlob = (blob: Blob): Promise<string> => blob.text();

/** The entries of a ZIP blob: path -> bytes. */
export async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

export const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

// ---- jobs ------------------------------------------------------------------------------------------------------------------

export const FOLDER = 'Discord Export';

export function appSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    common: exportSettings(),
    showButtons: true,
    showQueuedIndicator: false,
    zipAll: false,
    folderName: FOLDER,
    dateInFileName: true,
    timeZone: 'auto',
    notifyOnComplete: true,
    language: 'en',
    consentAt: 1,
    ...overrides,
  };
}

export function engineJob(overrides: Partial<EngineJob> = {}): EngineJob {
  return {
    jobId: 'job-1',
    accountId: ACCOUNT_ID,
    authorization: TOKEN,
    items: [],
    settings: appSettings(),
    lastExported: {},
    locale: 'en',
    timeZone: SEOUL,
    ...overrides,
  };
}

/** The chats of the little world below. */
export const CHATS = ['800000000000000101', '800000000000000102', '800000000000000103'] as const;
export const NAMES = ['alpha', 'beta', 'gamma'] as const;
const GUILD_NAME = 'Test Guild';

/** What the popup's queue would hold for chat `n` (0..2). */
export function chatTarget(n: number): ChatTarget {
  return guildTarget(CHATS[n], { guildId: WORLD_GUILD_ID, guildName: GUILD_NAME, channelName: NAMES[n] });
}

/** A job over some of the chats (default: all three), every chat exported as `format` with `settings`. */
export function jobOf(
  chats: readonly number[] = [0, 1, 2],
  settings: Partial<ExportSettings> = {},
  overrides: Partial<EngineJob> & { app?: Partial<AppSettings> } = {},
): EngineJob {
  const { app, ...rest } = overrides;
  return engineJob({
    items: chats.map((n) => ({ key: CHATS[n], target: chatTarget(n), settings: exportSettings({ count: null, format: 'json', ...settings }) })),
    settings: appSettings(app),
    ...rest,
  });
}

// ---- the world of the fake client ------------------------------------------------------------------------------------------

export const CDN = 'https://cdn.discordapp.com/attachments/1/2';

/** A signed CDN URL issued at `issued` (epoch seconds): the `ex` / `is` / `hm` parameters the engine looks at. */
export function signedUrl(id: string, name: string, issuedSeconds: number): string {
  return `${CDN}/${id}/${name}?ex=${(issuedSeconds + 86_400).toString(16)}&is=${issuedSeconds.toString(16)}&hm=abc`;
}

export const FRESH_SECONDS = Math.floor(NOW / 1000) - 60;
/** Issued eight hours before `NOW`: older than the six hours after which the engine asks Discord for a new signature. */
export const STALE_SECONDS = Math.floor(NOW / 1000) - 8 * 3600;

export interface ChatSpec {
  /** Messages in the chat (default 3). */
  messages?: number;
  /** Attachments: [id, file name, issued seconds] on the first message(s). */
  attachments?: ReadonlyArray<readonly [string, string, number]>;
}

/** A guild with the three chats; `specs[n]` describes chat n. */
export function chatWorld(specs: readonly ChatSpec[] = []): FakeWorld {
  return {
    guild: GUILD,
    channels: [channel(CATEGORY_ID, 4, { name: 'Text Channels' }), ...CHATS.map((id, n) => channel(id, 0, { name: NAMES[n], parent_id: CATEGORY_ID }))],
    messages: Object.fromEntries(
      CHATS.map((id, n) => {
        const spec = specs[n] ?? {};
        const count = spec.messages ?? 3;
        return [
          id,
          Array.from({ length: count }, (_, minute) =>
            msg(
              minute,
              `${NAMES[n]} ${minute}`,
              { attachments: minute === 0 ? (spec.attachments ?? []).map(([attachmentId, name, issued]) => ({ id: attachmentId, filename: name, size: 3, content_type: 'image/png', url: signedUrl(attachmentId, name, issued) })) : [] },
              id,
            ),
          ),
        ];
      }),
    ),
  };
}

/** The id of message number `minute` of a chat (what the incremental marker holds after an export). */
export const messageIdAt = (minute: number): string => msg(minute, '').id;

// ---- hand-made results of `exportChat` ---------------------------------------------------------------------------------------

/** The file of chat `n` as the library would name it (JSON, saved alone / inside a ZIP). */
export function outputOf(n: number, data = `{"chat":"${NAMES[n]}"}`): ChatOutput {
  return {
    path: `${FOLDER}/${GUILD_NAME} - ${NAMES[n]} (2026-10-06).json`,
    zipPath: `${GUILD_NAME}/Text Channels/${NAMES[n]}.json`,
    mime: 'application/json',
    data,
  };
}

/** An attachment of chat `n` with the paths the library would give it. */
export function attachmentOf(n: number, id: string, filename: string, url = signedUrl(id, filename, FRESH_SECONDS)): ChatAttachment {
  return {
    id,
    url,
    filename,
    path: `${FOLDER}/${GUILD_NAME} - ${NAMES[n]} (2026-10-06)_files/${id}_${filename}`,
    zipPath: `${GUILD_NAME}/Text Channels/${NAMES[n]}_files/${id}_${filename}`,
  };
}

/** A finished export of chat `n`: one file, no attachments, three messages. Override what the test is about. */
export function resultOf(n: number, overrides: Partial<ExportChatResult> = {}): ExportChatResult {
  return { outputs: [outputOf(n)], messageCount: 3, lastMessageId: messageIdAt(2), attachments: [], status: 'done', error: null, ...overrides };
}

/** An `exportChat` that answers from `results` (by chat id), or runs the library's for a chat without one. */
export function scriptedExport(results: Record<string, (() => ExportChatResult | Promise<ExportChatResult>) | undefined>): NonNullable<EngineDeps['exportChat']> {
  return async (client, target, settings, context) => {
    const scripted = results[target.channelId];
    if (scripted !== undefined) return scripted();
    const { exportChat } = await import('@/lib');
    return exportChat(client, target, settings, context);
  };
}

// ---- running ---------------------------------------------------------------------------------------------------------------

export interface Harness {
  runner: EngineRunner;
  fake: FakeIo;
  /** The pauses the engine asked for (ms), in order. */
  sleeps: number[];
  /** The CDN requests the engine made: url and the credentials mode of the request. */
  fetched: Array<{ url: string; credentials: RequestCredentials | undefined }>;
  clientOptions: LiveDiscordClientOptions[];
  client: FakeClient;
  setNow(ms: number): void;
}

export interface HarnessOptions {
  world?: FakeWorld;
  fail?: (call: FakeCall) => Failure | Promise<Failure>;
  io?: IoOptions;
  /** The CDN: url -> bytes (a number is an HTTP status instead). Default: 3 bytes for every URL. */
  cdn?: (url: string) => Uint8Array | number;
  deps?: EngineDeps;
  /** Replaces the fake client entirely. */
  client?: DiscordClient;
}

/** The engine over the fake client, the fake io and an instant clock: `harness.runner.run(job, harness.fake.io)` runs a job. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const fake = createIo(options.io);
  const sleeps: number[] = [];
  const fetched: Harness['fetched'] = [];
  const clientOptions: LiveDiscordClientOptions[] = [];
  const client = fakeClient(options.world ?? chatWorld(), options.fail);
  let now = NOW;
  let ids = 0;
  const runner = createEngineRunner({
    createClient: (opts) => {
      clientOptions.push(opts);
      return options.client ?? client;
    },
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    now: () => now,
    newId: () => `entry-${(ids += 1)}`,
    fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetched.push({ url, credentials: init?.credentials });
      const answer = options.cdn?.(url) ?? new Uint8Array([1, 2, 3]);
      return typeof answer === 'number' ? new Response('nope', { status: answer }) : new Response(answer as Uint8Array<ArrayBuffer>);
    }) as unknown as typeof fetch,
    ...options.deps,
  });
  return { runner, fake, sleeps, fetched, clientOptions, client, setNow: (ms) => void (now = ms) };
}

/** Runs `job` on the harness and returns what the engine told the background. */
export async function runJob(harness: Harness, job: EngineJob): Promise<Call[]> {
  await harness.runner.run(job, harness.fake.io);
  return harness.fake.calls;
}

// ---- the real client over a fake transport ---------------------------------------------------------------------------------

export interface FakeAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** An `HttpTransport` that answers from `answer(request, n)` (n counts the requests so far, from 0) and records them. */
export function fakeTransport(answer: (request: TransportRequest, n: number) => FakeAnswer): { transport: HttpTransport; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  const transport: HttpTransport = async (request) => {
    const n = requests.length;
    requests.push(request);
    const { status, body, headers = {} } = answer(request, n);
    return { status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  return { transport, requests };
}
