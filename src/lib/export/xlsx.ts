import { strToU8, zipSync } from 'fflate';

/**
 * Minimal XLSX (SpreadsheetML) writer — no spreadsheet library, so no formula engine and nothing to keep patched.
 *
 * Safety properties the exports rely on:
 *  - every string is an inline *string* cell (`t="inlineStr"`); this writer cannot emit a formula (`<f>`),
 *    so a message such as "=HYPERLINK(...)" is just text;
 *  - characters that are illegal in XML 1.0 are stripped, so a hostile message cannot make the file unreadable;
 *  - cells are capped at Excel's 32,767 character limit.
 */

export interface XlsxColumn {
  header: string;
  /** Width in characters (Excel units). Omitted => Excel's default. */
  width?: number;
  /** Wrap text inside the cells of this column (multi-line message bodies). */
  wrap?: boolean;
}

export interface XlsxBuilderOptions {
  sheetName: string;
  columns: readonly XlsxColumn[];
  /** Rows per sheet including the header row. Default and maximum: Excel's 1,048,576. */
  maxRowsPerSheet?: number;
  /** Stamped into docProps and the ZIP entries; defaults to now. */
  createdAt?: Date;
}

export type XlsxCell = string | number | null;

/** A last worksheet of plain "label | value" rows (what the file is about); string cells like everything else. */
export interface XlsxInfoSheet {
  /** Made legal and unique among the sheet names like any other name. */
  name: string;
  rows: ReadonlyArray<readonly [label: string, value: string]>;
}

export interface XlsxBuilder {
  /** Appends one data row. Missing trailing cells and `null`s stay empty; more cells than columns throws. */
  addRow(cells: readonly XlsxCell[]): void;
  /** Data rows added so far (header rows are not counted). */
  readonly rowCount: number;
  /** Assembles the .xlsx file, with `info` as an extra last worksheet. May be called repeatedly; rows can still be added afterwards. */
  build(info?: XlsxInfoSheet): Uint8Array;
}

const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_COLUMNS = 16_384;
const EXCEL_MAX_CELL_CHARS = 32_767;
const EXCEL_MAX_SHEET_NAME = 31;
const EXCEL_MAX_COLUMN_WIDTH = 255;
const TRUNCATION_MARKER = '...[truncated]';
/** Row XML is encoded to bytes in groups this size, so memory holds compact byte arrays instead of thousands of strings. */
const ROWS_PER_SEGMENT = 500;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * Style indices in styles.xml `cellXfs`. Index 0 stays Excel's untouched default; every cell we write carries an
 * explicit style, since some readers do not apply index 0 when `s` is absent.
 */
const STYLE_BODY = 1;
const STYLE_WRAP = 2;
const STYLE_HEADER = 3;

/** XML 1.0 forbids most C0 controls, U+FFFE/U+FFFF and unpaired surrogates (tab, LF and CR are fine). */
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const XML_SPECIAL = /[&<>"'\r]/g;
/**
 * Excel decodes "_x000D_"-style sequences in text, so every underscore that starts a literal one has to be written as
 * "_x005F_" ("_x000D_" => "_x005F_x000D_"). The lookahead keeps the sequence's closing underscore out of the match:
 * it may open the next sequence ("_x0041_x0042_" has two), which a consuming pattern would leave half escaped.
 */
const LITERAL_X_ESCAPE = /_(?=x[0-9A-Fa-f]{4}_)/g;
const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  // A literal CR would be normalised to LF by every XML parser; the character reference survives.
  '\r': '&#13;',
};

/** For names inside attributes and formulas, where Excel's "_xHHHH_" decoding does not apply. */
function escapeXml(text: string): string {
  return text.replace(XML_ILLEGAL, '').replace(XML_SPECIAL, (ch) => XML_ENTITIES[ch]);
}

function endsWithHighSurrogate(s: string, end: number): boolean {
  const code = s.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

/** Strips illegal characters, enforces Excel's per-cell limit (marking the cut) and escapes for element content. */
function cellText(raw: string): string {
  let text = raw.replace(XML_ILLEGAL, '');
  if (text.length > EXCEL_MAX_CELL_CHARS) {
    let end = EXCEL_MAX_CELL_CHARS - TRUNCATION_MARKER.length;
    if (endsWithHighSurrogate(text, end)) end -= 1;
    text = text.slice(0, end) + TRUNCATION_MARKER;
  }
  return text.replace(LITERAL_X_ESCAPE, '_x005F_').replace(XML_SPECIAL, (ch) => XML_ENTITIES[ch]);
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 701 -> "ZZ", 702 -> "AAA". */
function columnLetters(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Makes `name` legal as an Excel sheet name: at most 31 UTF-16 units, none of `[ ] : * ? / \`, not blank,
 * no leading/trailing apostrophe, and not Excel's reserved name "History".
 */
export function sanitizeSheetName(name: string): string {
  let s = name
    .replace(XML_ILLEGAL, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[[\]:*?/\\]/g, '_');
  s = s.slice(0, EXCEL_MAX_SHEET_NAME);
  if (s.length > 0 && endsWithHighSurrogate(s, s.length)) s = s.slice(0, -1);
  s = s.replace(/^['\s]+|['\s]+$/g, '');
  if (s === '') return 'Sheet';
  return s.toLowerCase() === 'history' ? `${s}_` : s;
}

function overflowSheetName(base: string, firstIndex: number, taken: ReadonlySet<string>): string {
  for (let n = firstIndex; ; n += 1) {
    const suffix = ` (${n})`;
    let head = base.slice(0, EXCEL_MAX_SHEET_NAME - suffix.length);
    if (head.length > 0 && endsWithHighSurrogate(head, head.length)) head = head.slice(0, -1);
    const name = `${head.trimEnd()}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** `name` made legal, and different (case-insensitively) from every name in `taken`. */
function uniqueSheetName(name: string, firstIndex: number, taken: ReadonlySet<string>): string {
  const base = sanitizeSheetName(name);
  return taken.has(base.toLowerCase()) ? overflowSheetName(base, firstIndex, taken) : base;
}

/** The worksheet of "label | value" rows: labels in the header style, values wrapped; empty strings stay empty cells. */
function infoSheetXml(rows: ReadonlyArray<readonly [label: string, value: string]>): string {
  let data = '';
  rows.forEach(([label, value], index) => {
    const row = index + 1;
    const cells =
      (label === '' ? '' : `<c r="A${row}" s="${STYLE_HEADER}" t="inlineStr"><is><t xml:space="preserve">${cellText(label)}</t></is></c>`) +
      (value === '' ? '' : `<c r="B${row}" s="${STYLE_WRAP}" t="inlineStr"><is><t xml:space="preserve">${cellText(value)}</t></is></c>`);
    if (cells !== '') data += `<row r="${row}">${cells}</row>`;
  });
  return (
    `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="A1:B${Math.max(1, rows.length)}"/>` +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="80" customWidth="1"/></cols>' +
    `<sheetData>${data}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
  );
}

interface SheetBuffer {
  name: string;
  /** Data rows only (the header row is written separately). */
  dataRows: number;
  segments: Uint8Array[];
  pending: string[];
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function w3cDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const STYLES_XML =
  `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="3">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="2">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '<dxfs count="0"/>' +
  '<tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>' +
  '</styleSheet>';

export function createXlsxBuilder(opts: XlsxBuilderOptions): XlsxBuilder {
  const columns = [...opts.columns];
  if (columns.length === 0) throw new RangeError('An XLSX sheet needs at least one column.');
  if (columns.length > EXCEL_MAX_COLUMNS) throw new RangeError(`Excel supports at most ${EXCEL_MAX_COLUMNS} columns.`);
  const maxRows = Math.min(opts.maxRowsPerSheet ?? EXCEL_MAX_ROWS, EXCEL_MAX_ROWS);
  if (!Number.isInteger(maxRows) || maxRows < 2) throw new RangeError('maxRowsPerSheet must be an integer of at least 2.');
  const maxDataRows = maxRows - 1;
  const createdAt = opts.createdAt ?? new Date();

  const encoder = new TextEncoder();
  const letters = columns.map((_, i) => columnLetters(i));
  const lastColumn = letters[letters.length - 1];
  const bodyStyles = columns.map((c) => (c.wrap ? STYLE_WRAP : STYLE_BODY));

  const headerRowXml =
    '<row r="1">' +
    columns
      .map((c, i) => {
        const text = cellText(c.header);
        return text === ''
          ? ''
          : `<c r="${letters[i]}1" s="${STYLE_HEADER}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
      })
      .join('') +
    '</row>';

  const colsXml = columns
    .map((c, i) => {
      const width = c.width;
      if (width === undefined || !Number.isFinite(width) || width <= 0) return '';
      return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(width, EXCEL_MAX_COLUMN_WIDTH)}" customWidth="1"/>`;
    })
    .join('');

  const sheets: SheetBuffer[] = [];
  const takenNames = new Set<string>();
  const baseName = sanitizeSheetName(opts.sheetName);
  let totalRows = 0;

  function openSheet(): SheetBuffer {
    const name = sheets.length === 0 ? baseName : overflowSheetName(baseName, sheets.length + 1, takenNames);
    takenNames.add(name.toLowerCase());
    const sheet: SheetBuffer = { name, dataRows: 0, segments: [], pending: [] };
    sheets.push(sheet);
    return sheet;
  }

  function flush(sheet: SheetBuffer): void {
    if (sheet.pending.length === 0) return;
    sheet.segments.push(encoder.encode(sheet.pending.join('')));
    sheet.pending = [];
  }

  function rowXml(rowNumber: number, cells: readonly XlsxCell[]): string {
    let xml = '';
    for (let i = 0; i < cells.length; i += 1) {
      const value = cells[i];
      const ref = `${letters[i]}${rowNumber}`;
      const style = ` s="${bodyStyles[i]}"`;
      if (typeof value === 'number') {
        // NaN and +-Infinity have no spreadsheet representation; they stay empty like null.
        if (Number.isFinite(value)) xml += `<c r="${ref}"${style}><v>${String(value).replace('e', 'E')}</v></c>`;
      } else if (typeof value === 'string') {
        const text = cellText(value);
        if (text !== '') xml += `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
      }
    }
    return xml === '' ? '' : `<row r="${rowNumber}">${xml}</row>`;
  }

  function sheetHead(sheet: SheetBuffer, index: number): string {
    const lastRow = sheet.dataRows + 1;
    const dimension = lastColumn === 'A' && lastRow === 1 ? 'A1' : `A1:${lastColumn}${lastRow}`;
    return (
      `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      `<dimension ref="${dimension}"/>` +
      `<sheetViews><sheetView${index === 0 ? ' tabSelected="1"' : ''} workbookViewId="0">` +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      (colsXml === '' ? '' : `<cols>${colsXml}</cols>`) +
      '<sheetData>'
    );
  }

  function sheetTail(sheet: SheetBuffer): string {
    return (
      `</sheetData><autoFilter ref="A1:${lastColumn}${sheet.dataRows + 1}"/>` +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
    );
  }

  function workbookXml(info: string | null): string {
    const sheetEntries =
      sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      (info === null ? '' : `<sheet name="${escapeXml(info)}" sheetId="${sheets.length + 1}" r:id="rId${sheets.length + 1}"/>`);
    // Excel itself writes this hidden name for every autofiltered sheet; keep it in sync with <autoFilter ref>.
    const filterNames = sheets
      .map((s, i) => {
        const range = `'${s.name.replace(/'/g, "''")}'!$A$1:$${lastColumn}$${s.dataRows + 1}`;
        return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXml(range)}</definedName>`;
      })
      .join('');
    return (
      `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300"/></bookViews>' +
      `<sheets>${sheetEntries}</sheets><definedNames>${filterNames}</definedNames></workbook>`
    );
  }

  /** Number of worksheets in the file: the data sheets and, when there is one, the info sheet. */
  const sheetCount = (info: string | null): number => sheets.length + (info === null ? 0 : 1);

  function workbookRelsXml(info: string | null): string {
    const sheetRels = Array.from(
      { length: sheetCount(info) },
      (_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    ).join('');
    return (
      `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">${sheetRels}` +
      `<Relationship Id="rId${sheetCount(info) + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`
    );
  }

  function contentTypesXml(info: string | null): string {
    const sheetOverrides = Array.from(
      { length: sheetCount(info) },
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join('');
    return (
      `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheetOverrides +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>'
    );
  }

  const rootRelsXml =
    `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>';

  const appXml =
    `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
    '<Application>Discord Chat Extractor</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop></Properties>';

  function coreXml(): string {
    const stamp = w3cDate(createdAt);
    return (
      `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:creator>Discord Chat Extractor</dc:creator><cp:lastModifiedBy>Discord Chat Extractor</cp:lastModifiedBy>' +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`
    );
  }

  openSheet();

  return {
    addRow(cells) {
      if (cells.length > columns.length) {
        throw new RangeError(`Row has ${cells.length} cells but the sheet has ${columns.length} columns.`);
      }
      let sheet = sheets[sheets.length - 1];
      if (sheet.dataRows >= maxDataRows) {
        flush(sheet);
        sheet = openSheet();
      }
      sheet.dataRows += 1;
      totalRows += 1;
      const xml = rowXml(sheet.dataRows + 1, cells);
      if (xml !== '') sheet.pending.push(xml);
      if (sheet.pending.length >= ROWS_PER_SEGMENT) flush(sheet);
    },

    get rowCount() {
      return totalRows;
    },

    build(info) {
      const infoName = info === undefined ? null : uniqueSheetName(info.name, sheets.length + 1, takenNames);
      const parts: Record<string, Uint8Array> = {
        '[Content_Types].xml': strToU8(contentTypesXml(infoName)),
        '_rels/.rels': strToU8(rootRelsXml),
        'docProps/app.xml': strToU8(appXml),
        'docProps/core.xml': strToU8(coreXml()),
        'xl/workbook.xml': strToU8(workbookXml(infoName)),
        'xl/_rels/workbook.xml.rels': strToU8(workbookRelsXml(infoName)),
        'xl/styles.xml': strToU8(STYLES_XML),
      };
      sheets.forEach((sheet, index) => {
        flush(sheet);
        parts[`xl/worksheets/sheet${index + 1}.xml`] = concatBytes([
          encoder.encode(sheetHead(sheet, index)),
          encoder.encode(headerRowXml),
          ...sheet.segments,
          encoder.encode(sheetTail(sheet)),
        ]);
      });
      if (info !== undefined) parts[`xl/worksheets/sheet${sheets.length + 1}.xml`] = encoder.encode(infoSheetXml(info.rows));
      // zipSync (not the streaming Zip) so entries carry their sizes up front, with no data descriptors.
      return zipSync(parts, { level: 6, mtime: createdAt });
    },
  };
}
