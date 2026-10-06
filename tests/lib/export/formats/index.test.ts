import { describe, expect, it } from 'vitest';
import { EXPORT_FORMATS } from '@/shared/types';
import type { ExportFormat } from '@/shared/types';
import type { Message } from '../../../../src/lib/discord/types';
import { csvFormat } from '../../../../src/lib/export/formats/csv';
import { htmlFormat } from '../../../../src/lib/export/formats/html';
import { loadExportFormat } from '../../../../src/lib/export/formats';
import { jsonFormat } from '../../../../src/lib/export/formats/json';
import { mdFormat } from '../../../../src/lib/export/formats/md';
import { txtFormat } from '../../../../src/lib/export/formats/txt';
import { xlsxFormat } from '../../../../src/lib/export/formats/xlsx';
import type { Chunk, ExportTarget, FormatModule, WriterOptions } from '../../../../src/lib/export/types';

/**
 * The real registry, with nothing mocked: without this file a wrong entry in the id -> module map would type-check and
 * pass every test.
 */

const EXPECTED: Record<ExportFormat, { module: FormatModule; extension: string; mime: RegExp }> = {
  html: { module: htmlFormat, extension: 'html', mime: /^text\/html/ },
  txt: { module: txtFormat, extension: 'txt', mime: /^text\/plain/ },
  md: { module: mdFormat, extension: 'md', mime: /^text\/markdown/ },
  xlsx: { module: xlsxFormat, extension: 'xlsx', mime: /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/ },
  csv: { module: csvFormat, extension: 'csv', mime: /^text\/csv/ },
  json: { module: jsonFormat, extension: 'json', mime: /^application\/json/ },
};

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

const MESSAGE: Message = {
  id: '100000000000000001',
  channel_id: '555',
  author: { id: '1000', username: 'alice', global_name: 'Alice' },
  content: 'hello **world**',
  timestamp: '2026-10-05T12:00:01.000000+00:00',
  edited_timestamp: null,
  mentions: [],
  mention_roles: [],
  attachments: [],
  embeds: [],
  type: 0,
};

const sizeOf = (chunks: readonly Chunk[]): number => chunks.reduce((sum, chunk) => sum + chunk.length, 0);

describe('loadExportFormat (real registry)', () => {
  it('knows every format id of the contract and no other', () => {
    expect([...EXPORT_FORMATS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(EXPORT_FORMATS)('loads "%s" as the module of that format', async (id) => {
    const format = await loadExportFormat(id);
    expect(format.id).toBe(id);
    expect(format.extension).toBe(EXPECTED[id].extension);
    expect(format.mime).toMatch(EXPECTED[id].mime);
    expect(format.label).toContain(`(.${EXPECTED[id].extension})`);
    expect(format).toBe(EXPECTED[id].module);
  });

  it.each(EXPORT_FORMATS)('"%s" produces a file through its writer', async (id) => {
    const format = await loadExportFormat(id);
    const options: WriterOptions = { after: null, before: null, limit: null, htmlTheme: 'dark', locale: 'en', timeZone: 'UTC' };
    const writer = format.createWriter({
      target: TARGET,
      options,
      exportedAt: new Date('2026-10-06T12:00:00Z'),
      names: { user: () => undefined, channel: () => undefined, role: () => undefined },
    });
    const chunks = [
      ...writer.start(),
      ...writer.write([MESSAGE]),
      ...writer.end({ messageCount: 1, firstTimestamp: MESSAGE.timestamp, lastTimestamp: MESSAGE.timestamp }),
    ];
    expect(sizeOf(chunks)).toBeGreaterThan(50);
  });

  it('gives every format its own extension', async () => {
    const formats = await Promise.all(EXPORT_FORMATS.map((id) => loadExportFormat(id)));
    expect(new Set(formats.map((format) => format.extension)).size).toBe(EXPORT_FORMATS.length);
  });
});
