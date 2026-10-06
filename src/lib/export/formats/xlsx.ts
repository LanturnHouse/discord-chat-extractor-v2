import type { Message } from '../../discord/types';
import { createXlsxBuilder } from '../xlsx';
import type { XlsxInfoSheet } from '../xlsx';
import type { Chunk, ExportWriter, FormatModule, WriterContext, WriterSummary } from '../types';
import { applyContentOptions } from './content';
import { channelPath } from './parts';
import { createRowBuilder, hasLocalFilesColumn, rowColumns, rowHeaders } from './rows';
import { formatStamp, GENERATOR_NAME, getExportStrings, hasRestrictedScope, oneLine, resolveTimeZone, scopeRows } from './text';

/** ZIP stores DOS dates, which only cover 1980-2099: anything else (an invalid Date, a mocked clock) must not fail the export. */
function zipTimestamp(date: Date): Date {
  const year = date.getFullYear();
  return year >= 1980 && year <= 2099 ? date : new Date();
}

/** The "Info" worksheet: what the header of a TXT file says (server, channel, scope, export time) plus the footer's counts. */
function infoSheet(ctx: WriterContext, summary: WriterSummary): XlsxInfoSheet {
  const { target, options, exportedAt } = ctx;
  const timeZone = resolveTimeZone(options.timeZone);
  const strings = getExportStrings(options.locale);
  const rows: Array<readonly [string, string]> = [];
  if (target.guildName) rows.push([strings.server, oneLine(target.guildName)]);
  rows.push([strings.channel, channelPath(target)]);
  const topic = oneLine(target.topic);
  if (topic !== '') rows.push([strings.topic, topic]);
  rows.push(...scopeRows(options, timeZone));
  rows.push(
    [strings.exportedAt, `${formatStamp(exportedAt.toISOString(), timeZone)} (${timeZone})`],
    [strings.generator, GENERATOR_NAME],
    [strings.messages, String(summary.messageCount)],
  );
  if (summary.firstTimestamp) rows.push([strings.firstMessage, formatStamp(summary.firstTimestamp, timeZone)]);
  if (summary.lastTimestamp) rows.push([strings.lastMessage, formatStamp(summary.lastTimestamp, timeZone)]);
  return { name: strings.infoSheet, rows };
}

/**
 * Same columns and values as the CSV export. The builder keeps rows only as encoded XML and writes nothing but
 * string cells, so ids stay exact and a message such as "=HYPERLINK(...)" is text, never a formula; nothing has to be
 * neutralised here. The file is assembled in `end()`.
 *
 * A file whose scope is restricted (a count, a range, incremental or partial) gets a second worksheet, "Info" / "정보", that
 * says so; a plain export of the whole channel stays a single sheet, exactly as in v1. With saved attachment copies a
 * "Local Files" column follows "Attachments".
 */
function createXlsxWriter(ctx: WriterContext): ExportWriter {
  const toRow = createRowBuilder(ctx);
  const withLocalFiles = hasLocalFilesColumn(ctx.options);
  const headers = rowHeaders(ctx.options.locale, withLocalFiles);
  const builder = createXlsxBuilder({
    sheetName: ctx.target.channelName,
    columns: rowColumns(withLocalFiles).map((column, index) => ({ header: headers[index], width: column.width, wrap: column.wrap })),
    createdAt: zipTimestamp(ctx.exportedAt),
  });

  return {
    start(): Chunk[] {
      return [];
    },

    write(batch: readonly Message[]): Chunk[] {
      for (const message of applyContentOptions(batch, ctx.options.content)) builder.addRow(toRow(message));
      return [];
    },

    end(summary: WriterSummary): Chunk[] {
      return [builder.build(hasRestrictedScope(ctx.options) ? infoSheet(ctx, summary) : undefined)];
    },
  };
}

export const xlsxFormat: FormatModule = {
  id: 'xlsx',
  label: 'Excel (.xlsx)',
  extension: 'xlsx',
  mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  createWriter: createXlsxWriter,
};
