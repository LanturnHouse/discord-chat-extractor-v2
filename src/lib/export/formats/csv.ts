import type { Message } from '../../discord/types';
import type { Chunk, ExportWriter, FormatModule, WriterContext } from '../types';
import { applyContentOptions } from './content';
import { csvRow } from './csvEncode';
import { createRowBuilder, hasLocalFilesColumn, rowColumns, rowHeaders } from './rows';

/** Excel only detects UTF-8 (and so shows Korean correctly) when the file starts with a byte order mark. */
const BOM = String.fromCharCode(0xfeff);

/**
 * One CSV row per message. Rows are produced batch by batch, so nothing but the current batch is ever held.
 *
 * Message ID, Author ID and Reply To are written as `="123456789012345678"` (csvEncode.ts `idTextCell`), not as bare digits:
 * Excel reads a bare 18-digit field as a number, shows it as 1.23457E+17 and keeps only 15 digits when the file is saved
 * again, so the ids could no longer be matched with Discord or with the JSON / XLSX export. The text formula is the spelling
 * that Excel, LibreOffice and Google Sheets all keep as text; a program that reads the file as plain CSV sees the quoted text
 * `="123..."` and has to strip the `="` and `"` (the JSON export carries the plain ids). Every other cell that could be read as
 * a formula still gets a leading quote, and the file still starts with the BOM.
 *
 * There is no header block: a CSV is a table, and any metadata line above the column names would break it. The scope of the
 * export (count, range, incremental, partial) is in the file name; JSON / XLSX / TXT / MD / HTML carry it inside.
 * With saved attachment copies a "Local Files" column follows "Attachments".
 */
function createCsvWriter(ctx: WriterContext): ExportWriter {
  const toRow = createRowBuilder(ctx);
  const withLocalFiles = hasLocalFilesColumn(ctx.options);
  const idCells = rowColumns(withLocalFiles).map((column) => column.id === true);

  return {
    start(): Chunk[] {
      return [BOM + csvRow(rowHeaders(ctx.options.locale, withLocalFiles))];
    },

    write(batch: readonly Message[]): Chunk[] {
      let out = '';
      for (const message of applyContentOptions(batch, ctx.options.content)) out += csvRow(toRow(message), idCells);
      return out === '' ? [] : [out];
    },

    end(): Chunk[] {
      return [];
    },
  };
}

export const csvFormat: FormatModule = {
  id: 'csv',
  label: 'CSV (.csv)',
  extension: 'csv',
  mime: 'text/csv;charset=utf-8',
  createWriter: createCsvWriter,
};
