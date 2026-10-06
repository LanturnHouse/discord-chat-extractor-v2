import ExcelJS from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createMockClient, MOCK_IDS } from '../../../../src/lib/discord/mock';
import type { Message, User } from '../../../../src/lib/discord/types';
import { createRowBuilder, ROW_COLUMNS } from '../../../../src/lib/export/formats/rows';
import { bytesOf, exportMock } from '../exportKit';
import { xlsxFormat } from '../../../../src/lib/export/formats/xlsx';
import { sanitizeSheetName } from '../../../../src/lib/export/xlsx';
import type { Chunk, WriterOptions, ExportTarget, WriterContext } from '../../../../src/lib/export/types';
import { buildNameResolver } from '../../../../src/lib/message';
import { expectLinearScaling, inflateMessages } from '../scaling';

const ALICE: User = { id: '1000', username: 'alice', global_name: 'Alice' };
const BOB: User = { id: '2000', username: 'bob' };
const BOT: User = { id: '4000', username: 'helper', bot: true };

const OPTIONS: WriterOptions = { after: null, before: null, limit: null, htmlTheme: 'dark', locale: 'en', timeZone: 'UTC' };
const TARGET: ExportTarget = {
  channelId: '555',
  kind: 'text',
  channelName: 'general',
  guildId: '777',
  guildName: 'My Server',
  categoryName: 'Text Channels',
  parentChannelName: null,
  topic: null,
};
const NO_NAMES = { user: () => undefined, channel: () => undefined, role: () => undefined };

function context(overrides: { options?: Partial<WriterOptions>; target?: Partial<ExportTarget>; names?: WriterContext['names'] } = {}): WriterContext {
  return {
    target: { ...TARGET, ...overrides.target },
    options: { ...OPTIONS, ...overrides.options },
    exportedAt: new Date('2026-10-06T12:34:56.000Z'),
    names: overrides.names ?? NO_NAMES,
  };
}

function message(n: number, content: string, extra: Partial<Message> = {}): Message {
  return {
    id: String(100000000000000000n + BigInt(n)),
    channel_id: '555',
    author: ALICE,
    content,
    timestamp: `2026-10-05T12:00:${String(n % 60).padStart(2, '0')}.000000+00:00`,
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...extra,
  };
}

function build(batches: Message[][], ctx: WriterContext = context()): Uint8Array {
  const writer = xlsxFormat.createWriter(ctx);
  const all = batches.flat();
  const chunks: Chunk[] = [...writer.start()];
  for (const batch of batches) chunks.push(...writer.write(batch));
  chunks.push(...writer.end({ messageCount: all.length, firstTimestamp: all[0]?.timestamp ?? null, lastTimestamp: all[all.length - 1]?.timestamp ?? null }));
  expect(chunks).toHaveLength(1);
  const [file] = chunks;
  if (!(file instanceof Uint8Array)) throw new Error('the xlsx writer must return bytes');
  return file;
}

async function load(xlsx: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(xlsx) as unknown as ArrayBuffer);
  return workbook;
}

/** Every cell as a string; a numeric, date or formula cell makes the test fail. */
function readRows(sheet: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= ROW_COLUMNS.length; c += 1) {
      const cell = row.getCell(c);
      const value = cell.value;
      if (value === null || value === undefined) {
        cells.push('');
        continue;
      }
      expect(typeof value, `cell ${cell.address}`).toBe('string');
      expect(cell.type, `cell ${cell.address}`).toBe(ExcelJS.ValueType.String);
      cells.push(value as string);
    }
    rows.push(cells);
  }
  return rows;
}

async function showcase(): Promise<{ messages: Message[]; names: ReturnType<typeof buildNameResolver> }> {
  const client = createMockClient({ latencyMs: 0 });
  const messages: Message[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await client.getMessages(MOCK_IDS.showcaseChannel, { before, limit: 100 });
    if (page.length === 0) break;
    messages.push(...page);
    before = page[page.length - 1].id;
  }
  messages.reverse();
  const names = buildNameResolver();
  names.addMessages(messages);
  return { messages, names };
}

describe('xlsxFormat', () => {
  it('describes itself', () => {
    expect(xlsxFormat.id).toBe('xlsx');
    expect(xlsxFormat.label).toBe('Excel (.xlsx)');
    expect(xlsxFormat.extension).toBe('xlsx');
    expect(xlsxFormat.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('returns the whole file as one byte chunk from end() and nothing before', () => {
    const writer = xlsxFormat.createWriter(context());
    expect(writer.start()).toEqual([]);
    expect(writer.write([message(1, 'x')])).toEqual([]);
    const chunks = writer.end({ messageCount: 1, firstTimestamp: null, lastTimestamp: null });
    expect(chunks).toHaveLength(1);
    const file = chunks[0];
    expect(file).toBeInstanceOf(Uint8Array);
    expect([...(file as Uint8Array).slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it('is deterministic: the zip carries the export time, not the wall clock', () => {
    expect(Buffer.from(build([[message(1, 'x')]])).equals(Buffer.from(build([[message(1, 'x')]])))).toBe(true);
  });

  it('still builds when the export time is outside the range a ZIP can store', async () => {
    for (const exportedAt of [new Date(0), new Date(NaN), new Date('2150-01-01T00:00:00Z')]) {
      const wb = await load(build([[message(1, 'x')]], { ...context(), exportedAt }));
      expect(readRows(wb.worksheets[0])).toHaveLength(2);
    }
  });

  describe('workbook', () => {
    it('names the sheet after the channel, sanitised', async () => {
      const wb = await load(build([[message(1, 'x')]]));
      expect(wb.worksheets.map((s) => s.name)).toEqual(['general']);

      const odd = await load(build([[message(1, 'x')]], context({ target: { channelName: 'a/b:c?*[x]' } })));
      expect(odd.worksheets[0].name).toBe(sanitizeSheetName('a/b:c?*[x]'));
      expect(odd.worksheets[0].name).not.toMatch(/[[\]:*?/\\]/);

      const dm = await load(build([[message(1, 'x')]], context({ target: { kind: 'dm', channelName: '김민준', guildId: null, guildName: null, categoryName: null } })));
      expect(dm.worksheets[0].name).toBe('김민준');
    });

    it('writes the localised header row, frozen, with column widths and wrapping', async () => {
      const wb = await load(build([[message(1, 'x')]]));
      const sheet = wb.worksheets[0];
      expect(readRows(sheet)[0]).toEqual(['Message ID', 'Timestamp', 'Edited', 'Author ID', 'Author', 'Bot', 'Content', 'Attachments', 'Embeds', 'Stickers', 'Reactions', 'Reply To', 'Type']);
      expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      ROW_COLUMNS.forEach((column, index) => expect(sheet.getColumn(index + 1).width).toBe(column.width));
      expect(sheet.getRow(2).getCell(7).alignment?.wrapText).toBe(true);
      expect(sheet.getRow(2).getCell(1).alignment?.wrapText).toBeFalsy();

      const ko = await load(build([], context({ options: { locale: 'ko' } })));
      expect(readRows(ko.worksheets[0])[0]).toEqual(['메시지 ID', '시각', '수정 시각', '작성자 ID', '작성자', '봇', '내용', '첨부 파일', '임베드', '스티커', '리액션', '답장 대상', '유형']);
    });

    it('is a valid workbook with only the header row for an empty channel', async () => {
      const wb = await load(build([[], []]));
      const sheet = wb.worksheets[0];
      expect(sheet.rowCount).toBe(1);
      expect(readRows(sheet)).toHaveLength(1);
    });
  });

  describe('exact rows', () => {
    const original = message(1, 'hello');
    const reply = message(2, 'hi **Alice**', {
      author: BOB,
      type: 19,
      edited_timestamp: '2026-10-05T12:05:00.000000+00:00',
      message_reference: { message_id: original.id },
      referenced_message: original,
      reactions: [
        { count: 3, emoji: { id: null, name: '👍' } },
        { count: 2, emoji: { id: '123456789012345678', name: 'party' } },
      ],
    });
    const files = message(3, '', {
      attachments: [
        { id: '9', filename: 'report.pdf', size: 2048, url: 'https://cdn.discordapp.com/attachments/1/2/report.pdf' },
        { id: '10', filename: 'photo.png', size: 10, url: 'https://cdn.discordapp.com/attachments/1/3/photo.png' },
      ],
    });
    const join = message(4, '', { author: BOT, type: 7 });

    it('writes the same cells as the CSV model, every one a string', async () => {
      const wb = await load(build([[original, reply, files, join]]));
      expect(readRows(wb.worksheets[0])).toEqual([
        ['Message ID', 'Timestamp', 'Edited', 'Author ID', 'Author', 'Bot', 'Content', 'Attachments', 'Embeds', 'Stickers', 'Reactions', 'Reply To', 'Type'],
        ['100000000000000001', '2026-10-05 12:00:01', '', '1000', 'Alice', '', 'hello', '', '', '', '', '', 'message'],
        ['100000000000000002', '2026-10-05 12:00:02', '2026-10-05 12:05:00', '2000', 'bob', '', 'hi Alice', '', '', '', '👍 3; :party: 2', '100000000000000001', 'reply'],
        [
          '100000000000000003',
          '2026-10-05 12:00:03',
          '',
          '1000',
          'Alice',
          '',
          '',
          'https://cdn.discordapp.com/attachments/1/2/report.pdf\nhttps://cdn.discordapp.com/attachments/1/3/photo.png',
          '',
          '',
          '',
          '',
          'message',
        ],
        ['100000000000000004', '2026-10-05 12:00:04', '', '4000', 'helper', 'Y', 'helper joined the server.', '', '', '', '', '', 'system'],
      ]);
    });

    it('keeps snowflakes exact: text cells, never numbers', async () => {
      const big = message(1, 'x', { id: '1234567890123456789', author: { ...ALICE, id: '9007199254740993' } });
      const wb = await load(build([[big]]));
      const row = wb.worksheets[0].getRow(2);
      expect(row.getCell(1).value).toBe('1234567890123456789');
      expect(row.getCell(1).type).toBe(ExcelJS.ValueType.String);
      expect(row.getCell(4).value).toBe('9007199254740993');
      expect(Number.isSafeInteger(Number(big.id))).toBe(false);
    });

    it('stores Korean, emoji and line breaks verbatim', async () => {
      const body = '안녕하세요 👋\n두 번째 줄\n\n세 번째 🇰🇷 👨‍👩‍👧‍👦 <b>';
      const wb = await load(build([[message(1, body)]]));
      expect(readRows(wb.worksheets[0])[1][6]).toBe(body);
    });
  });

  describe('safety', () => {
    const hostile = [
      "=cmd|' /C calc'!A0",
      '=HYPERLINK("https://evil.example","click")',
      '+SUM(A1:A9)',
      "-2+3+cmd|' /C calc'!A0",
      '@SUM(1+1)*cmd',
      '\t=1+1',
      '=1+1\n=2+2',
      '<?xml version="1.0"?><x>&amp;</x>',
      '&#x0;]]></t></is></c>',
    ];

    it('keeps hostile text as plain strings: no formulas, no numbers', async () => {
      const messages = hostile.map((body, i) => message(i + 1, body, { author: i === 1 ? { id: '666', username: 'evil', global_name: '=1+1' } : ALICE }));
      const xlsx = build([messages]);
      const parts = unzipSync(xlsx);
      const sheetXml = strFromU8(parts['xl/worksheets/sheet1.xml']);
      expect(sheetXml).not.toMatch(/<f[ >]/);
      expect(sheetXml).not.toContain('<v>');
      expect(sheetXml).not.toMatch(/t="(n|str|b|e)"/);

      const rows = readRows((await load(xlsx)).worksheets[0]);
      expect(rows).toHaveLength(hostile.length + 1);
      const build_ = createRowBuilder(context());
      messages.forEach((m, i) => expect(rows[i + 1]).toEqual(build_(m)));
      expect(rows[1][6]).toBe("=cmd|' /C calc'!A0");
      expect(rows[2][4]).toBe('=1+1');
      expect(rows[3][6]).toBe('+SUM(A1:A9)');
      expect(rows[6][6]).toBe('=1+1');
      expect(rows[7][6]).toBe('=1+1\n=2+2');
    });

    it('survives characters that are illegal in XML', async () => {
      const wb = await load(build([[message(1, 'bell:\u0007 nul:\u0000 vt:\u000B unit:\u001F ok'), message(2, 'lone \uD800 surrogate')]]));
      const rows = readRows(wb.worksheets[0]);
      expect(rows[1][6]).toBe('bell: nul: vt:\n unit: ok');
      expect(rows[2][6]).toBe(`lone ${String.fromCharCode(0xfffd)} surrogate`);
    });

    it('cuts text at the 32,767-character cell limit of Excel and says so', async () => {
      const wb = await load(build([[message(1, 'x'.repeat(40_000))]]));
      const content = readRows(wb.worksheets[0])[1][6];
      expect(content).toHaveLength(32_767);
      expect(content.endsWith('...[truncated]')).toBe(true);
    });
  });

  it('writes identical bytes for one batch and for seven batches', () => {
    const messages = Array.from({ length: 60 }, (_, i) => message(i + 1, i % 4 === 0 ? `line\n${i} 안녕` : `message ${i}`, { author: i % 2 === 0 ? ALICE : BOB }));
    const sevenBatches = [messages.slice(0, 5), messages.slice(5, 9), messages.slice(9, 10), messages.slice(10, 30), [], messages.slice(30, 45), messages.slice(45)];
    expect(Buffer.from(build(sevenBatches)).equals(Buffer.from(build([messages])))).toBe(true);
  });

  it('creates independent writers', () => {
    const a = xlsxFormat.createWriter(context());
    const b = xlsxFormat.createWriter(context());
    a.write([message(1, 'x'), message(2, 'y')]);
    const countRows = async (chunks: Chunk[]): Promise<number> => (await load(chunks[0] as Uint8Array)).worksheets[0].rowCount;
    return Promise.all([
      countRows(a.end({ messageCount: 2, firstTimestamp: null, lastTimestamp: null })),
      countRows(b.end({ messageCount: 0, firstTimestamp: null, lastTimestamp: null })),
    ]).then(([rowsA, rowsB]) => {
      expect(rowsA).toBe(3);
      expect(rowsB).toBe(1);
    });
  });

  it('works end to end through exportChat with the demo client', async () => {
    const result = await exportMock(MOCK_IDS.showcaseChannel, 'xlsx');
    expect(result).toMatchObject({ status: 'done', error: null });
    expect(result.outputs).toHaveLength(1);
    const [output] = result.outputs;
    expect(output!.path).toBe('Discord Export/개발자 라운지 - feature-showcase (2026-10-06).xlsx');
    expect(output!.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(output!.data).toBeInstanceOf(Uint8Array);
    const wb = await load(bytesOf(output!));
    // the whole channel, nothing restricted: a single sheet, as in v1
    expect(wb.worksheets.map((s) => s.name)).toEqual(['feature-showcase']);
    const rows = readRows(wb.worksheets[0]);
    expect(rows).toHaveLength(result.messageCount + 1);
    expect(rows.some((row) => row[6].includes('@Sam Patel'))).toBe(true);
  });

  describe('mock showcase channel', () => {
    it('reads back as the row model, row for row', async () => {
      const { messages, names } = await showcase();
      const ctx = context({ names, options: { timeZone: 'Asia/Seoul' } });
      const rows = readRows((await load(build([messages.slice(0, 50), messages.slice(50)], ctx))).worksheets[0]);
      expect(rows).toHaveLength(messages.length + 1);
      const toRow = createRowBuilder(ctx);
      messages.forEach((m, i) => expect(rows[i + 1]).toEqual(toRow(m)));
    });

    it('carries the hostile samples as inert text', async () => {
      const { messages, names } = await showcase();
      const rows = readRows((await load(build([messages], context({ names })))).worksheets[0]);
      expect(rows.some((row) => row[6].startsWith('=SUM(1+1)*cmd'))).toBe(true);
      expect(rows.some((row) => row[4].startsWith('=HYPERLINK'))).toBe(true);
    });

    it('writes 20,000 messages in time proportional to their number', async () => {
      const { messages, names } = await showcase();
      const inflated = inflateMessages(messages, 20_000);
      const file = expectLinearScaling(
        (count) => {
          const writer = xlsxFormat.createWriter(context({ names }));
          writer.start();
          for (let i = 0; i < count; i += 100) writer.write(inflated.slice(i, Math.min(count, i + 100)));
          const [built] = writer.end({ messageCount: count, firstTimestamp: null, lastTimestamp: null });
          return built as Uint8Array;
        },
        { small: 2_000, large: 20_000 },
      );
      expect(file.length).toBeGreaterThan(100_000);
    });
  });
});

/** Like `readRows`, for a table of `width` columns. */
function readTable(sheet: ExcelJS.Worksheet, width: number): string[][] {
  const rows: string[][] = [];
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const cells: string[] = [];
    for (let c = 1; c <= width; c += 1) {
      const value = sheet.getRow(r).getCell(c).value;
      if (value === null || value === undefined) cells.push('');
      else {
        expect(typeof value, `cell ${r}:${c}`).toBe('string');
        cells.push(value as string);
      }
    }
    rows.push(cells);
  }
  return rows;
}

const EVERYTHING = { includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: true };

describe('xlsx: the info worksheet (the scope header of an Excel file)', () => {
  const info = async (options: Partial<WriterOptions>, target: Partial<ExportTarget> = {}, summaryOf: Message[] = [message(1, 'a'), message(2, 'b')]): Promise<string[][]> => {
    const wb = await load(build([summaryOf], context({ options, target })));
    expect(wb.worksheets).toHaveLength(2);
    return readTable(wb.worksheets[1]!, 2);
  };

  it('a plain export of the whole channel stays a single sheet, exactly as in v1', async () => {
    expect((await load(build([[message(1, 'a')]]))).worksheets.map((s) => s.name)).toEqual(['general']);
    expect((await load(build([[message(1, 'a')]], context({ options: { incremental: false, partial: false } })))).worksheets).toHaveLength(1);
  });

  it.each([
    ['a count', { limit: 200 }],
    ['a start', { after: '2026-01-01T00:00:00.000Z' }],
    ['an end', { before: '2026-03-01T00:00:00.000Z' }],
    ['an incremental export', { incremental: true }],
    ['a partial export', { partial: true }],
  ] as const)('%s adds an "Info" sheet after the data sheet', async (_name, options) => {
    const wb = await load(build([[message(1, 'a')]], context({ options })));
    expect(wb.worksheets.map((s) => s.name)).toEqual(['general', 'Info']);
    // the data sheet is untouched and stays the first (and active) one
    expect(readRows(wb.worksheets[0]!)).toHaveLength(2);
  });

  it('says what the header of a TXT file says: server, channel, scope, export time, generator and the counts', async () => {
    const rows = await info({ limit: 200, timeZone: 'Asia/Seoul' }, { topic: 'Welcome!' });
    expect(rows).toEqual([
      ['Server', 'My Server'],
      ['Channel', 'Text Channels / #general'],
      ['Topic', 'Welcome!'],
      ['Range', 'newest 200 messages'],
      ['Exported', '2026-10-06 21:34:56 (Asia/Seoul)'],
      ['Generator', 'Discord Chat Extractor'],
      ['Messages', '2'],
      ['First message', '2026-10-05 21:00:01'],
      ['Last message', '2026-10-05 21:00:02'],
    ]);
  });

  it('shows the incremental and the partial flag as rows of their own', async () => {
    const rows = await info({ limit: 50, incremental: true, partial: true });
    const labels = rows.map(([label]) => label);
    expect(labels).toEqual(['Server', 'Channel', 'Range', 'Incremental', 'Status', 'Exported', 'Generator', 'Messages', 'First message', 'Last message']);
    expect(rows.find(([label]) => label === 'Incremental')![1]).toBe('only messages after the previous export');
    expect(rows.find(([label]) => label === 'Status')![1]).toBe('Partial - the export stopped early, so messages may be missing');
  });

  it('is written in Korean for a Korean export, sheet name included', async () => {
    const wb = await load(build([[message(1, 'a')]], context({ options: { limit: 5, partial: true, locale: 'ko' } })));
    expect(wb.worksheets.map((s) => s.name)).toEqual(['general', '정보']);
    const rows = readTable(wb.worksheets[1]!, 2);
    expect(rows.map(([label]) => label)).toEqual(['서버', '채널', '범위', '상태', '내보낸 시각', '생성 도구', '메시지 수', '첫 메시지', '마지막 메시지']);
    expect(rows[2]).toEqual(['범위', '최근 5개 메시지']);
  });

  it('a DM has no server row; an empty export has no first / last message', async () => {
    const dm = await load(build([[]], context({ options: { limit: 5 }, target: { kind: 'dm', guildId: null, guildName: null, categoryName: null, channelName: 'Alice' } })));
    const rows = readTable(dm.worksheets[1]!, 2);
    expect(rows.map(([label]) => label)).toEqual(['Channel', 'Range', 'Exported', 'Generator', 'Messages']);
    expect(rows[0]).toEqual(['Channel', 'Alice']);
    expect(rows[4]).toEqual(['Messages', '0']);
  });

  it('the info sheet gets another name when the channel is called "Info"', async () => {
    const wb = await load(build([[message(1, 'a')]], context({ options: { limit: 5 }, target: { channelName: 'Info' } })));
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Info', 'Info (2)']);
    const lower = await load(build([[message(1, 'a')]], context({ options: { limit: 5 }, target: { channelName: 'info' } })));
    expect(lower.worksheets.map((s) => s.name)).toEqual(['info', 'Info (2)']);
  });

  it('keeps every cell a string and treats hostile text as inert text', async () => {
    const wb = await load(build([[message(1, 'a')]], context({ options: { limit: 5 }, target: { guildName: '=SUM(1)', channelName: '@evil', topic: '+cmd|calc' } })));
    const rows = readTable(wb.worksheets[1]!, 2);
    expect(rows[0]![1]).toBe('=SUM(1)');
    expect(rows[2]![1]).toBe('+cmd|calc');
    const zip = unzipSync(build([[message(1, 'a')]], context({ options: { limit: 5 }, target: { guildName: '=SUM(1)' } })));
    expect(strFromU8(zip['xl/worksheets/sheet2.xml']!)).not.toContain('<f>');
    expect(strFromU8(zip['xl/worksheets/sheet2.xml']!)).not.toMatch(/t="(?!inlineStr)[a-z]+"/);
  });

  it('the package is consistent: content types, relationships and the styles part follow the extra sheet', async () => {
    const zip = unzipSync(build([[message(1, 'a')]], context({ options: { limit: 5 } })));
    expect(Object.keys(zip).sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/app.xml',
        'docProps/core.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
      ].sort(),
    );
    const types = strFromU8(zip['[Content_Types].xml']!);
    expect(types).toContain('/xl/worksheets/sheet2.xml');
    const rels = strFromU8(zip['xl/_rels/workbook.xml.rels']!);
    expect(rels).toContain('Id="rId1"');
    expect(rels).toContain('Id="rId2"');
    expect(rels).toMatch(/Id="rId3"[^>]*Target="styles\.xml"/);
    const workbook = strFromU8(zip['xl/workbook.xml']!);
    expect(workbook).toContain('<sheet name="Info" sheetId="2" r:id="rId2"/>');
    // the autofilter name only exists for the data sheet
    expect(workbook.match(/_xlnm\._FilterDatabase/g)).toHaveLength(1);
    expect(strFromU8(zip['xl/worksheets/sheet1.xml']!)).toContain('tabSelected="1"');
    expect(strFromU8(zip['xl/worksheets/sheet2.xml']!)).not.toContain('tabSelected');
  });

});

describe('xlsx: saved attachment copies and content options', () => {
  const withFiles = message(1, 'files', {
    attachments: [
      { id: '9', filename: 'report.pdf', size: 2048, url: 'https://cdn.discordapp.com/attachments/1/2/report.pdf' },
      { id: '10', filename: 'photo.png', size: 10, url: 'https://cdn.discordapp.com/attachments/1/3/photo.png' },
    ],
  });

  it('adds a "Local Files" column right behind "Attachments", with the saved path on the line of its attachment', async () => {
    const wb = await load(build([[withFiles]], context({ options: { attachmentPaths: new Map([['10', 'chat_files/10_photo.png']]) } })));
    const rows = readTable(wb.worksheets[0]!, 14);
    expect(rows[0]!.slice(7, 10)).toEqual(['Attachments', 'Local Files', 'Embeds']);
    expect(rows[1]![8]).toBe('\nchat_files/10_photo.png');
    expect(rows[1]![7]!.split('\n')).toHaveLength(2);
  });

  it('without a path map the table is the v1 table (13 columns)', async () => {
    const wb = await load(build([[withFiles]]));
    expect(readRows(wb.worksheets[0]!)[0]).toHaveLength(13);
    const header = readTable(wb.worksheets[0]!, 14)[0]!;
    expect(header[13]).toBe('');
  });

  it('the new column has its own width and wraps like Attachments', async () => {
    const zip = unzipSync(build([[withFiles]], context({ options: { attachmentPaths: new Map() } })));
    const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']!);
    expect(sheet).toMatch(/<col min="9" max="9" width="50" customWidth="1"\/>/);
    expect(sheet).toContain('<dimension ref="A1:N2"/>');
  });

  it('applies the content options like the other formats: bots, system messages, reactions and embeds', async () => {
    const bot = message(2, 'bot', { author: BOT });
    const join = message(3, '', { type: 7 });
    const rich = message(4, 'rich', { reactions: [{ count: 2, emoji: { id: null, name: '👍' } }], embeds: [{ title: 'An embed' }] });
    const all = [message(1, 'human'), bot, join, rich];
    const rowsOf = async (content: Partial<typeof EVERYTHING>): Promise<string[][]> =>
      readRows((await load(build([all], context({ options: { content: { ...EVERYTHING, ...content } } })))).worksheets[0]!).slice(1);
    expect((await rowsOf({})).map((r) => r[6])).toEqual(['human', 'bot', 'Alice joined the server.', 'rich']);
    expect((await rowsOf({ includeBots: false })).map((r) => r[6])).toEqual(['human', 'Alice joined the server.', 'rich']);
    expect((await rowsOf({ includeSystem: false })).map((r) => r[6])).toEqual(['human', 'bot', 'rich']);
    const noExtras = await rowsOf({ includeReactions: false, includeEmbeds: false });
    expect(noExtras[3]![10]).toBe('');
    expect(noExtras[3]![8]).toBe('');
    const full = await rowsOf({});
    expect(full[3]![10]).toBe('👍 2');
    expect(full[3]![8]).toContain('An embed');
  });

  it('with everything included the file is byte-for-byte what it was without options', () => {
    const messages = [message(1, 'a'), message(2, 'b', { author: BOT })];
    const plain = build([messages]);
    const optioned = build([messages], context({ options: { content: EVERYTHING } }));
    expect(Buffer.from(optioned).equals(Buffer.from(plain))).toBe(true);
  });
});
