/**
 * `exportChat` and the files around it: saved attachment copies (the list the engine downloads and the links inside the
 * files), the ZIP paths of several chats, and whole jobs run the way the engine runs them (docs/PLAN.md §6.3, §6.5, §6.6):
 * finished chats survive a 401, packaging survives a cancel.
 */
import ExcelJS from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ExportFormat, ExportSettings } from '@/shared/types';
import { DiscordApiError, isAbortError } from '../../../src/lib/discord/client';
import type { Attachment, Message } from '../../../src/lib/discord/types';
import { exportChat } from '../../../src/lib/export/chat';
import type { ExportChatContext, ExportChatResult } from '../../../src/lib/export/chat';
import { ZipAssembler } from '../../../src/lib/export/zip';
import { bytesOf, context, NOW, settings, target, textOf } from './exportKit';
import { BOT, CATEGORY_ID, channel, fakeClient, GUILD, GUILD_ID, idAt, msg, TEXT_ID } from './fakeClient';
import type { FakeClient, FakeWorld } from './fakeClient';

const CDN = 'https://cdn.discordapp.com/attachments/1/2';

function att(id: string, filename: string, extra: Partial<Attachment> = {}): Attachment {
  return { id, filename, size: 10, content_type: 'image/png', url: `${CDN}/${id}/${filename.replace(/ /g, '_')}?ex=1&is=2&hm=3`, ...extra };
}

function world(messages: Message[], extra: Partial<FakeWorld> = {}): FakeWorld {
  return {
    guild: GUILD,
    channels: [channel(CATEGORY_ID, 4, { name: 'Text Channels' }), channel(TEXT_ID, 0, { name: 'general', parent_id: CATEGORY_ID })],
    messages: { [TEXT_ID]: messages },
    ...extra,
  };
}

interface Over {
  format?: ExportFormat;
  settings?: Partial<ExportSettings>;
  ctx?: Partial<ExportChatContext>;
  channelId?: string;
}

const run = (client: FakeClient, over: Over = {}): Promise<ExportChatResult> =>
  exportChat(client, target(over.channelId ?? TEXT_ID, { guildId: GUILD_ID }), settings(over.format ?? 'json', { includeAttachments: true, ...over.settings }), context(over.ctx));

interface JsonAttachment {
  id: string;
  filename: string;
  url: string;
  local_path?: string;
}
interface JsonMessage {
  content: string;
  attachments: JsonAttachment[];
  message_snapshots?: Array<{ message: { attachments: JsonAttachment[] } }>;
}
const messagesOf = (result: ExportChatResult, index = 0): JsonMessage[] => (JSON.parse(textOf(result.outputs[index]!)) as { messages: JsonMessage[] }).messages;
const dirname = (path: string): string => path.slice(0, path.lastIndexOf('/'));

/** Every `local_path` a JSON file announces, forwarded messages included. */
function localPaths(result: ExportChatResult, index = 0): string[] {
  const found: string[] = [];
  for (const message of messagesOf(result, index)) {
    for (const a of message.attachments) if (a?.local_path !== undefined) found.push(a.local_path);
    for (const snapshot of message.message_snapshots ?? []) for (const a of snapshot.message.attachments) if (a?.local_path !== undefined) found.push(a.local_path);
  }
  return found;
}

const apiError = (kind: DiscordApiError['kind']): DiscordApiError => new DiscordApiError(kind, `raw ${kind}`);

// ---------------------------------------------------------------------------------------------------------------------
// the attachments of a chat
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: attachments', () => {
  const cat = att('1', 'cat.png');
  const report = att('2', 'report final.pdf', { content_type: 'application/pdf' });
  const forwarded = att('3', 'fwd.png');
  const messages = (): Message[] => [
    msg(0, 'first', { attachments: [cat, report] }),
    msg(1, 'again', { attachments: [cat] }),
    msg(2, 'fwd', { message_reference: { type: 1 }, message_snapshots: [{ message: { content: 'forwarded', attachments: [forwarded], embeds: [], timestamp: new Date().toISOString() } }] } as Partial<Message>),
  ];
  const fake = (extra: Message[] = []): FakeClient => fakeClient(world([...messages(), ...extra]));

  it('lists nothing and links nothing unless asked to save attachments', async () => {
    const result = await run(fake(), { settings: { includeAttachments: false } });
    expect(result.attachments).toEqual([]);
    expect(localPaths(result)).toEqual([]);
    expect(textOf(result.outputs[0]!)).not.toContain('local_path');
  });

  it('lists every attachment once, with the signed URL as the message carried it and the paths to save it at', async () => {
    const result = await run(fake());
    expect(result.attachments).toEqual([
      {
        id: '1',
        url: cat.url,
        filename: 'cat.png',
        path: 'Discord Export/Test Guild - general (2026-10-06)_files/1_cat.png',
        zipPath: 'Test Guild/Text Channels/general_files/1_cat.png',
      },
      {
        id: '2',
        url: report.url,
        filename: 'report final.pdf',
        path: 'Discord Export/Test Guild - general (2026-10-06)_files/2_report final.pdf',
        zipPath: 'Test Guild/Text Channels/general_files/2_report final.pdf',
      },
      {
        id: '3',
        url: forwarded.url,
        filename: 'fwd.png',
        path: 'Discord Export/Test Guild - general (2026-10-06)_files/3_fwd.png',
        zipPath: 'Test Guild/Text Channels/general_files/3_fwd.png',
      },
    ]);
  });

  it('announces the copies in the file, relative to the file: next to it when saved alone', async () => {
    const result = await run(fake());
    expect(localPaths(result)).toEqual([
      'Test Guild - general (2026-10-06)_files/1_cat.png',
      'Test Guild - general (2026-10-06)_files/2_report final.pdf',
      'Test Guild - general (2026-10-06)_files/1_cat.png',
      'Test Guild - general (2026-10-06)_files/3_fwd.png',
    ]);
  });

  it('announces them relative to the place of the file in the ZIP when the files go into a ZIP', async () => {
    const result = await run(fake(), { ctx: { zip: true } });
    expect(localPaths(result)).toEqual(['general_files/1_cat.png', 'general_files/2_report final.pdf', 'general_files/1_cat.png', 'general_files/3_fwd.png']);
    expect(result.attachments.map((a) => a.zipPath)).toEqual([
      'Test Guild/Text Channels/general_files/1_cat.png',
      'Test Guild/Text Channels/general_files/2_report final.pdf',
      'Test Guild/Text Channels/general_files/3_fwd.png',
    ]);
  });

  it.each([false, true])('every link of the file resolves to the path the attachment is saved at (zip: %s)', async (zip) => {
    const result = await run(fake(), { ctx: { zip } });
    const home = dirname(zip ? result.outputs[0]!.zipPath : result.outputs[0]!.path);
    const saved = new Set(result.attachments.map((a) => (zip ? a.zipPath : a.path)));
    expect(saved.size).toBe(3);
    for (const local of localPaths(result)) expect(saved.has(`${home}/${local}`), local).toBe(true);
  });

  it('points the HTML and Markdown files at the copies (percent-encoded), and keeps the CDN for everything else', async () => {
    const html = textOf((await run(fake(), { format: 'html' })).outputs[0]!);
    expect(html).toContain('src="Test%20Guild%20-%20general%20%282026-10-06%29_files/1_cat.png"');
    expect(html).toContain('href="Test%20Guild%20-%20general%20%282026-10-06%29_files/2_report%20final.pdf"');
    expect(html).not.toContain('cdn.discordapp.com/attachments/1/2/1/cat.png');
    const md = textOf((await run(fake(), { format: 'md' })).outputs[0]!);
    expect(md).toContain('Test%20Guild%20-%20general%20%282026-10-06%29_files/1_cat.png');
    expect(md).toContain('Test%20Guild%20-%20general%20%282026-10-06%29_files/2_report%20final.pdf');
  });

  it('writes the copies next to the attachments in the text formats', async () => {
    for (const format of ['txt', 'csv'] as const) {
      const text = textOf((await run(fake(), { format })).outputs[0]!);
      expect(text, format).toContain('Test Guild - general (2026-10-06)_files/1_cat.png');
      expect(text, format).toContain('Test Guild - general (2026-10-06)_files/2_report final.pdf');
    }
    const csv = textOf((await run(fake(), { format: 'csv' })).outputs[0]!);
    expect(csv).toContain('Local Files');
  });

  it('writes them into the Excel file as well', async () => {
    const bytes = bytesOf((await run(fake(), { format: 'xlsx' })).outputs[0]!);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const cells: string[] = [];
    workbook.worksheets[0]!.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? ''))));
    expect(cells.some((value) => value.includes('Test Guild - general (2026-10-06)_files/1_cat.png'))).toBe(true);
    expect(cells).toContain('Local Files');
  });

  it('leaves out attachments of messages the content options drop', async () => {
    const bot = msg(5, 'beep', { author: BOT, attachments: [att('9', 'bot.png')] });
    const result = await run(fake([bot]), { settings: { content: { includeBots: false, includeSystem: true, includeReactions: true, includeEmbeds: true } } });
    expect(result.attachments.map((a) => a.id)).toEqual(['1', '2', '3']);
    const all = await run(fake([bot]));
    expect(all.attachments.map((a) => a.id)).toEqual(['1', '2', '3', '9']);
  });

  it('skips attachments that cannot be downloaded: no id, no URL, or a URL that is not http(s)', async () => {
    const odd: Message = msg(5, 'odd', {
      attachments: [
        { ...att('', 'noid.png') },
        { ...att('10', 'nourl.png'), url: '' },
        { ...att('11', 'script.png'), url: 'javascript:alert(1)' },
        { ...att('12', 'data.png'), url: 'data:image/png;base64,AAAA' },
        { ...att('13', 'file.png'), url: 'file:///etc/passwd' },
        { ...att('14', 'ok.png') },
        null as unknown as Attachment,
      ],
    });
    const result = await run(fakeClient(world([odd])));
    expect(result.attachments.map((a) => a.id)).toEqual(['14']);
    expect(localPaths(result)).toEqual(['Test Guild - general (2026-10-06)_files/14_ok.png']);
  });

  it('keeps hostile and reserved file names inside the folder of the file', async () => {
    const names = ['../../evil.png', 'CON.txt', 'a/b\\c.png', 'trailing dot.', ' lead.png', 'x'.repeat(400) + '.png', 'ünï/cödé.png', ''];
    const hostile = msg(5, 'hostile', { attachments: names.map((name, i) => att(String(100 + i), name)) });
    const result = await run(fakeClient(world([hostile])));
    expect(result.attachments).toHaveLength(names.length);
    for (const a of result.attachments) {
      const parts = a.path.split('/');
      expect(parts.slice(0, 2), a.path).toEqual(['Discord Export', 'Test Guild - general (2026-10-06)_files']);
      expect(parts, a.path).toHaveLength(3);
      expect(parts.every((part) => part !== '..' && part !== '.' && part !== ''), a.path).toBe(true);
      expect(a.path.length, a.path).toBeLessThanOrEqual(180);
      expect(parts[2]!.startsWith(`${a.id}_`), a.path).toBe(true);
      const zipParts = a.zipPath.split('/');
      expect(zipParts.slice(0, 3), a.zipPath).toEqual(['Test Guild', 'Text Channels', 'general_files']);
      expect(zipParts, a.zipPath).toHaveLength(4);
    }
    // the copies are announced under the same names
    expect(localPaths(result)).toEqual(result.attachments.map((a) => a.path.slice('Discord Export/'.length)));
  });

  it('keeps the attachments of every thread next to the file of that thread', async () => {
    const thread = { id: idAt(20), type: 11, guild_id: GUILD_ID, parent_id: TEXT_ID, name: 'Photos', last_message_id: idAt(21) };
    const client = fakeClient(
      world([msg(0, 'main', { attachments: [att('1', 'cat.png')] })], {
        channels: [channel(CATEGORY_ID, 4, { name: 'Text Channels' }), channel(TEXT_ID, 0, { name: 'general', parent_id: CATEGORY_ID }), thread],
        messages: { [TEXT_ID]: [msg(0, 'main', { attachments: [att('1', 'cat.png')] })], [thread.id]: [msg(21, 'in thread', { attachments: [att('2', 'dog.png')] }, thread.id)] },
        threads: { [TEXT_ID]: [thread] },
      }),
    );
    const result = await run(client, { settings: { includeThreads: true } });
    expect(result.outputs).toHaveLength(2);
    expect(result.attachments.map((a) => a.path)).toEqual([
      'Discord Export/Test Guild - general (2026-10-06)_files/1_cat.png',
      'Discord Export/Test Guild - general - Photos (2026-10-06)_files/2_dog.png',
    ]);
    expect(localPaths(result, 0)).toEqual(['Test Guild - general (2026-10-06)_files/1_cat.png']);
    expect(localPaths(result, 1)).toEqual(['Test Guild - general - Photos (2026-10-06)_files/2_dog.png']);
  });

  it('lists the attachments of the messages a partial export did reach', async () => {
    const many = Array.from({ length: 250 }, (_, i) => msg(i, `m${i}`, { attachments: [att(String(1000 + i), `f${i}.png`)] }));
    const client = fakeClient(world(many), (call) => (call.method === 'getMessages' && call.n === 1 ? apiError('network') : undefined));
    const result = await run(client);
    expect(result.status).toBe('partial');
    expect(result.attachments).toHaveLength(100);
    expect(result.attachments[0]!.id).toBe('1150');
    expect(result.outputs[0]!.path).toContain('(partial)');
    // the copies of a partial file sit next to the partial file
    expect(result.attachments[0]!.path.startsWith('Discord Export/Test Guild - general (2026-10-06) (partial)_files/')).toBe(true);
  });

  it('is happy with a chat that has no attachments at all', async () => {
    const result = await run(fakeClient(world([msg(0, 'plain')])));
    expect(result).toMatchObject({ status: 'done', attachments: [] });
    expect(localPaths(result)).toEqual([]);
  });

  it('keeps the HTML policy strict when nothing was saved, and widens it only for saved copies', async () => {
    const none = textOf((await run(fakeClient(world([msg(0, 'plain')])), { format: 'html' })).outputs[0]!);
    expect(none).toContain("img-src https: data:;");
    const some = textOf((await run(fake(), { format: 'html' })).outputs[0]!);
    expect(some).toContain("img-src 'self' file: https: data:;");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ZIP paths of several chats
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: ZIP paths of the chats of one job', () => {
  const second = '800000000000000020';
  const twin = '800000000000000021';
  const channels = [
    channel(CATEGORY_ID, 4, { name: 'Text Channels' }),
    channel(TEXT_ID, 0, { name: 'general', parent_id: CATEGORY_ID }),
    channel(second, 0, { name: 'General', parent_id: CATEGORY_ID }),
    channel(twin, 0, { name: 'general', parent_id: CATEGORY_ID }),
  ];
  const fake = (): FakeClient =>
    fakeClient({
      guild: GUILD,
      channels,
      messages: { [TEXT_ID]: [msg(0, 'a')], [second]: [msg(1, 'b', {}, second)], [twin]: [msg(2, 'c', {}, twin)] },
    });

  it('gives chats whose names differ only by case different entries, and remembers them in the shared set', async () => {
    const client = fake();
    const used = new Set<string>();
    const a = await run(client, { ctx: { usedZipPaths: used, zip: true }, channelId: TEXT_ID });
    const b = await run(client, { ctx: { usedZipPaths: used, zip: true }, channelId: second });
    const c = await run(client, { ctx: { usedZipPaths: used, zip: true }, channelId: twin });
    expect(a.outputs[0]!.zipPath).toBe('Test Guild/Text Channels/general.json');
    expect(b.outputs[0]!.zipPath).toBe(`Test Guild/Text Channels/General [${second}].json`);
    expect(c.outputs[0]!.zipPath).toBe(`Test Guild/Text Channels/general [${twin}].json`);
    expect([...used]).toEqual([a.outputs[0]!.zipPath, b.outputs[0]!.zipPath, c.outputs[0]!.zipPath]);
  });

  it('exports the same chat twice into one ZIP without clashing', async () => {
    const client = fake();
    const used = new Set<string>();
    const first = await run(client, { ctx: { usedZipPaths: used } });
    const again = await run(client, { ctx: { usedZipPaths: used } });
    expect(first.outputs[0]!.zipPath).not.toBe(again.outputs[0]!.zipPath);
    expect(used.size).toBe(2);
  });

  it('shares nothing between calls that do not share a set', async () => {
    const client = fake();
    const first = await run(client);
    const again = await run(client);
    expect(again.outputs[0]!.zipPath).toBe(first.outputs[0]!.zipPath);
  });

  it('the individual paths of the same chats clash only per chat, not per job: Chrome uniquifies those', async () => {
    const client = fake();
    const a = await run(client, { channelId: TEXT_ID });
    const b = await run(client, { channelId: twin });
    expect(a.outputs[0]!.path).toBe(b.outputs[0]!.path);
  });

  it('puts a partial chat into the ZIP under a name that says so', async () => {
    const client = fakeClient(
      { guild: GUILD, channels, messages: { [TEXT_ID]: Array.from({ length: 250 }, (_, i) => msg(i, `m${i}`)) } },
      (call) => (call.method === 'getMessages' && call.n === 1 ? apiError('server') : undefined),
    );
    const used = new Set<string>();
    const result = await run(client, { ctx: { usedZipPaths: used } });
    expect(result.outputs[0]!.zipPath).toBe('Test Guild/Text Channels/general (partial).json');
    expect([...used]).toEqual([result.outputs[0]!.zipPath]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// jobs, the way the engine runs them
// ---------------------------------------------------------------------------------------------------------------------

describe('a job of several chats (the engine loop around exportChat)', () => {
  const ids = ['800000000000000101', '800000000000000102', '800000000000000103'];
  const names = ['alpha', 'beta', 'gamma'];

  function jobWorld(): FakeWorld {
    return {
      guild: GUILD,
      channels: [channel(CATEGORY_ID, 4, { name: 'Text Channels' }), ...ids.map((id, i) => channel(id, 0, { name: names[i], parent_id: CATEGORY_ID }))],
      messages: Object.fromEntries(ids.map((id, i) => [id, Array.from({ length: i === 1 ? 250 : 3 }, (_, n) => msg(n, `${names[i]} ${n}`, { attachments: n === 0 ? [att(`${i + 1}0`, `${names[i]}.png`)] : [] }, id))])),
    };
  }

  async function files(blob: Blob): Promise<Record<string, Uint8Array>> {
    return unzipSync(new Uint8Array(await blob.arrayBuffer()));
  }

  /** What the offscreen engine does: one chat after the other, finished and partial chats into the ZIP, stop on a 401. */
  async function job(client: FakeClient, over: { signal?: AbortSignal; attachments?: boolean } = {}) {
    const used = new Set<string>();
    const zip = new ZipAssembler(() => NOW);
    const results: ExportChatResult[] = [];
    let stopped: string | null = null;
    for (const id of ids) {
      const result = await exportChat(client, target(id, { guildId: GUILD_ID }), settings('json', { includeAttachments: over.attachments === true }), context({ zip: true, usedZipPaths: used, signal: over.signal }));
      results.push(result);
      for (const output of result.outputs) await zip.add(output.zipPath, output.data);
      for (const attachment of result.attachments) await zip.add(attachment.zipPath, new Uint8Array([1, 2, 3]));
      if (result.error?.kind === 'auth') {
        stopped = id;
        break;
      }
    }
    return { zip, results, stopped };
  }

  it('a 401 in the middle of a job keeps the chats that were finished', async () => {
    const client = fakeClient(jobWorld(), (call) => (call.method === 'getMessages' && call.id === ids[1] ? apiError('auth') : undefined));
    const { zip, results, stopped } = await job(client);
    expect(results.map((r) => r.status)).toEqual(['done', 'failed']);
    expect(results[1]!.error?.kind).toBe('auth');
    expect(stopped).toBe(ids[1]);
    expect(client.calls('getMessages').some((c) => c.id === ids[2])).toBe(false);
    const entries = await files(await zip.finish());
    expect(Object.keys(entries)).toEqual(['Test Guild/Text Channels/alpha.json']);
    expect(strFromU8(entries['Test Guild/Text Channels/alpha.json']!)).toBe(textOf(results[0]!.outputs[0]!));
  });

  it('a 401 after some messages keeps the partial chat as well, marked partial', async () => {
    const client = fakeClient(jobWorld(), (call) => (call.method === 'getMessages' && call.id === ids[1] && call.n === 1 ? apiError('auth') : undefined));
    const { zip, results } = await job(client);
    expect(results.map((r) => r.status)).toEqual(['done', 'partial']);
    expect(results[1]!.error?.kind).toBe('auth');
    const entries = await files(await zip.finish());
    expect(Object.keys(entries)).toEqual(['Test Guild/Text Channels/alpha.json', 'Test Guild/Text Channels/beta (partial).json']);
    expect((JSON.parse(strFromU8(entries['Test Guild/Text Channels/beta (partial).json']!)) as { messages: unknown[] }).messages).toHaveLength(100);
  });

  it('a cancel while packaging cannot take the finished chats away', async () => {
    const client = fakeClient(jobWorld());
    const controller = new AbortController();
    const { zip, results } = await job(client);
    expect(results.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    // a late entry is cancelled, the archive is as it was
    const late = zip.add('late.json', 'x', { signal: (controller.abort(), controller.signal) });
    await expect(late).rejects.toSatisfy((error: unknown) => isAbortError(error));
    const entries = await files(await zip.finish());
    expect(Object.keys(entries)).toEqual(['Test Guild/Text Channels/alpha.json', 'Test Guild/Text Channels/beta.json', 'Test Guild/Text Channels/gamma.json']);
  });

  it('a cancel during a chat is an AbortError, and the chats before it are still there to be packaged', async () => {
    const controller = new AbortController();
    const client = fakeClient(jobWorld(), (call) => {
      if (call.method === 'getMessages' && call.id === ids[1] && call.n === 1) controller.abort();
      return undefined;
    });
    const used = new Set<string>();
    const zip = new ZipAssembler(() => NOW);
    let cancelled = false;
    for (const id of ids) {
      try {
        const result = await exportChat(client, target(id, { guildId: GUILD_ID }), settings('json'), context({ zip: true, usedZipPaths: used, signal: controller.signal }));
        for (const output of result.outputs) await zip.add(output.zipPath, output.data);
      } catch (error) {
        expect(isAbortError(error)).toBe(true);
        cancelled = true;
        break;
      }
    }
    expect(cancelled).toBe(true);
    const entries = await files(await zip.finish());
    expect(Object.keys(entries)).toEqual(['Test Guild/Text Channels/alpha.json']);
  });

  it('every link in the files of the ZIP leads to an entry of the ZIP', async () => {
    const client = fakeClient(jobWorld());
    const { zip, results } = await job(client, { attachments: true });
    const entries = await files(await zip.finish());
    const jsonEntries = Object.keys(entries).filter((name) => name.endsWith('.json'));
    expect(jsonEntries).toHaveLength(3);
    let links = 0;
    for (const name of jsonEntries) {
      const doc = JSON.parse(strFromU8(entries[name]!)) as { messages: JsonMessage[] };
      for (const message of doc.messages) {
        for (const a of message.attachments) {
          if (a.local_path === undefined) continue;
          links += 1;
          expect(entries[`${dirname(name)}/${a.local_path}`], `${name} -> ${a.local_path}`).toBeInstanceOf(Uint8Array);
        }
      }
    }
    expect(links).toBe(3);
    expect(results.flatMap((r) => r.attachments)).toHaveLength(3);
    expect(Object.keys(entries)).toHaveLength(6);
  });

  it('the paths the engine gets are the names the ZIP stores: the assembler never has to rename an entry', async () => {
    const client = fakeClient(jobWorld());
    const used = new Set<string>();
    const zip = new ZipAssembler(() => NOW);
    for (const id of ids) {
      const result = await exportChat(client, target(id, { guildId: GUILD_ID }), settings('json', { includeAttachments: true }), context({ zip: true, usedZipPaths: used }));
      for (const output of result.outputs) expect(await zip.add(output.zipPath, output.data)).toBe(output.zipPath);
      for (const attachment of result.attachments) expect(await zip.add(attachment.zipPath, new Uint8Array([1]))).toBe(attachment.zipPath);
    }
    expect(zip.entryCount).toBe(6);
  });

  it('chats saved on their own never get more than 180 characters of path, attachments included', async () => {
    const long = 'λ'.repeat(120);
    const client = fakeClient({
      guild: { ...GUILD, name: long },
      channels: [channel(TEXT_ID, 0, { name: long })],
      messages: { [TEXT_ID]: [msg(0, 'x', { attachments: [att('1', `${long}.png`)] })] },
    });
    const result = await run(client, { ctx: { folderName: 'f'.repeat(60) + '/' + 'g'.repeat(60) } });
    for (const path of [result.outputs[0]!.path, ...result.attachments.map((a) => a.path)]) expect(path.length).toBeLessThanOrEqual(180);
    const local = localPaths(result)[0]!;
    expect(result.attachments[0]!.path.endsWith(`/${local}`)).toBe(true);
  });
});
