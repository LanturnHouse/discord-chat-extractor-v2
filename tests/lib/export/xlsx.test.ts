// @vitest-environment jsdom
import ExcelJS from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createXlsxBuilder, sanitizeSheetName, type XlsxBuilderOptions, type XlsxCell, type XlsxInfoSheet } from '../../../src/lib/export/xlsx';

const FIXED_DATE = new Date('2026-10-06T12:34:56.789Z');

function build(opts: Partial<XlsxBuilderOptions>, rows: XlsxCell[][] = []): Uint8Array {
  const builder = createXlsxBuilder({
    sheetName: 'Messages',
    columns: [{ header: 'A' }, { header: 'B' }],
    createdAt: FIXED_DATE,
    ...opts,
  });
  rows.forEach((row) => builder.addRow(row));
  return builder.build();
}

function parts(xlsx: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(unzipSync(xlsx))) out[name] = strFromU8(bytes);
  return out;
}

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function isWellFormed(xml: string): boolean {
  return parse(xml).getElementsByTagName('parsererror').length === 0;
}

async function load(xlsx: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(xlsx) as unknown as ArrayBuffer);
  return workbook;
}

function cellValues(sheet: ExcelJS.Worksheet): (ExcelJS.CellValue | undefined)[][] {
  const rows: (ExcelJS.CellValue | undefined)[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push((row.values as ExcelJS.CellValue[]).slice(1));
  });
  return rows;
}

describe('XML validity helpers', () => {
  it('detects malformed XML (sanity check for the other tests)', () => {
    expect(isWellFormed('<a><b></a>')).toBe(false);
    expect(isWellFormed('<a>\u0001</a>')).toBe(false);
    expect(isWellFormed('<a>&bogus;</a>')).toBe(false);
    expect(isWellFormed('<a><b/></a>')).toBe(true);
  });
});

describe('package structure', () => {
  const files = parts(build({ columns: [{ header: 'A', width: 12 }, { header: 'B', wrap: true }] }, [['x', 'y']]));

  it('contains exactly the expected parts, with [Content_Types].xml first', () => {
    const names = Object.keys(unzipSync(build({}, [['x', 'y']])));
    expect(names[0]).toBe('[Content_Types].xml');
    expect(names.sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/app.xml',
        'docProps/core.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ].sort(),
    );
  });

  it('every XML part is well-formed', () => {
    for (const [name, xml] of Object.entries(files)) {
      expect(isWellFormed(xml), name).toBe(true);
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), name).toBe(true);
    }
  });

  it('relationship targets all exist and content types cover every part', () => {
    const rels = parse(files['_rels/.rels']).getElementsByTagName('Relationship');
    const rootTargets = Array.from(rels).map((r) => r.getAttribute('Target'));
    expect(rootTargets).toEqual(['xl/workbook.xml', 'docProps/core.xml', 'docProps/app.xml']);

    const wbRels = Array.from(parse(files['xl/_rels/workbook.xml.rels']).getElementsByTagName('Relationship'));
    for (const rel of wbRels) expect(files[`xl/${rel.getAttribute('Target')}`]).toBeDefined();
    expect(new Set(wbRels.map((r) => r.getAttribute('Id'))).size).toBe(wbRels.length);

    const overrides = Array.from(parse(files['[Content_Types].xml']).getElementsByTagName('Override')).map((o) =>
      o.getAttribute('PartName'),
    );
    expect(overrides.sort()).toEqual(
      ['/docProps/app.xml', '/docProps/core.xml', '/xl/styles.xml', '/xl/workbook.xml', '/xl/worksheets/sheet1.xml'].sort(),
    );
  });

  it('has no formulas and no shared strings anywhere', () => {
    const joined = Object.values(files).join('\n');
    expect(joined).not.toMatch(/<f[ >]/);
    expect(joined).not.toMatch(/sharedStrings/);
    expect(joined).not.toMatch(/t="s"/);
  });

  it('orders worksheet children as the schema requires', () => {
    const sheet = parse(files['xl/worksheets/sheet1.xml']).documentElement;
    expect(Array.from(sheet.children).map((c) => c.tagName)).toEqual([
      'dimension',
      'sheetViews',
      'sheetFormatPr',
      'cols',
      'sheetData',
      'autoFilter',
      'pageMargins',
    ]);
  });

  it('omits <cols> when no widths are given', () => {
    const plain = parts(build({}, [['x', 'y']]));
    expect(plain['xl/worksheets/sheet1.xml']).not.toContain('<cols>');
  });

  it('orders workbook children as the schema requires', () => {
    const workbook = parse(files['xl/workbook.xml']).documentElement;
    expect(Array.from(workbook.children).map((c) => c.tagName)).toEqual(['bookViews', 'sheets', 'definedNames']);
  });

  it('writes the hidden filter name in sync with the autoFilter range', () => {
    const xlsx = parts(build({ sheetName: "Bob's sheet" }, [['a', 'b'], ['c', 'd']]));
    const name = parse(xlsx['xl/workbook.xml']).getElementsByTagName('definedName')[0];
    expect(name.getAttribute('name')).toBe('_xlnm._FilterDatabase');
    expect(name.getAttribute('localSheetId')).toBe('0');
    expect(name.getAttribute('hidden')).toBe('1');
    expect(name.textContent).toBe("'Bob''s sheet'!$A$1:$B$3");
    expect(xlsx['xl/worksheets/sheet1.xml']).toContain('<autoFilter ref="A1:B3"/>');
  });

  it('declares matching cellXfs counts in styles.xml', () => {
    const styles = parse(files['xl/styles.xml']);
    for (const tag of ['fonts', 'fills', 'borders', 'cellXfs', 'cellStyleXfs', 'cellStyles']) {
      const el = styles.getElementsByTagName(tag)[0];
      expect(el.children.length, tag).toBe(Number(el.getAttribute('count')));
    }
  });

  it('references only style indices that exist', () => {
    const xlsx = parts(build({ columns: [{ header: 'A' }, { header: 'B', wrap: true }] }, [['x', 'y']]));
    const count = Number(parse(xlsx['xl/styles.xml']).getElementsByTagName('cellXfs')[0].getAttribute('count'));
    for (const match of xlsx['xl/worksheets/sheet1.xml'].matchAll(/ s="(\d+)"/g)) {
      expect(Number(match[1])).toBeLessThan(count);
    }
  });

  it('is deterministic for a fixed createdAt', () => {
    const a = build({}, [['x', 'y']]);
    const b = build({}, [['x', 'y']]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('stamps the creation time in core.xml as W3CDTF', () => {
    expect(files['docProps/core.xml']).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-06T12:34:56Z</dcterms:created>');
    expect(files['docProps/app.xml']).toContain('<Application>Discord Chat Extractor</Application>');
  });
});

describe('cell content (read back with ExcelJS)', () => {
  it('round-trips strings with newlines, emoji, Korean text and XML special characters', async () => {
    const rows: XlsxCell[][] = [
      ['line1\nline2\n\nline4', 'tab\there'],
      ['😀 party 🎉 👨\u200D👩\u200D👧', '안녕하세요, 디스코드 💬'],
      ['<b>&amp; "quotes" \'single\'</b>', '  leading and trailing  '],
      ['crlf\r\nline', 'lone\rcr'],
    ];
    const workbook = await load(build({}, rows));
    const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
    expect(cellValues(sheet)).toEqual([['A', 'B'], ...rows]);
  });

  it('keeps carriage returns as character references (a literal CR would be normalised away)', () => {
    const xml = parts(build({}, [['a\r\nb', 'c']]))['xl/worksheets/sheet1.xml'];
    expect(xml).toContain('a&#13;\nb');
    expect(xml).not.toContain('\r');
  });

  it('never turns formula-looking text into a formula', async () => {
    const dangerous = ['=SUM(1,2)', '+1+1', '-2+3', '@SUM(A1)', '=HYPERLINK("http://evil","x")', "'=1", '\t=1', '\r=1'];
    const workbook = await load(build({}, dangerous.map((d) => [d, d])));
    const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
    dangerous.forEach((text, i) => {
      const cell = sheet.getRow(i + 2).getCell(1);
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.value).toBe(text);
      expect(cell.formula).toBeUndefined();
    });
  });

  it('writes numbers as numeric cells and leaves null / missing cells empty', async () => {
    const workbook = await load(
      build({ columns: [{ header: 'n' }, { header: 's' }, { header: 'z' }] }, [
        [42, 'x', null],
        [-1.5, null],
        [1e21, '', 0],
        [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        [0.1 + 0.2, '7', -0],
      ]),
    );
    const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
    expect(sheet.getCell('A2').type).toBe(ExcelJS.ValueType.Number);
    expect(sheet.getCell('A2').value).toBe(42);
    expect(sheet.getCell('A3').value).toBe(-1.5);
    expect(sheet.getCell('B3').value).toBeNull();
    expect(sheet.getCell('C2').value).toBeNull();
    expect(sheet.getCell('A4').value).toBe(1e21);
    expect(sheet.getCell('B4').value).toBeNull();
    expect(sheet.getCell('C4').value).toBe(0);
    for (const ref of ['A5', 'B5', 'C5']) expect(sheet.getCell(ref).value).toBeNull();
    expect(sheet.getCell('A6').value).toBe(0.1 + 0.2);
    expect(sheet.getCell('B6').type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell('B6').value).toBe('7');
  });

  it('strips characters that are illegal in XML 1.0 but keeps tab, LF and CR', async () => {
    const dirty = 'a\u0000b\u0001c\u0008d\u000Be\u000Cf\u000Eg\u001Fh\uFFFEi\uFFFFj\uD800k\uDC00l\tm\nn\ro';
    const xml = parts(build({}, [[dirty, 'x']]))['xl/worksheets/sheet1.xml'];
    expect(isWellFormed(xml)).toBe(true);
    const workbook = await load(build({}, [[dirty, 'x']]));
    const value = (workbook.getWorksheet('Messages') as ExcelJS.Worksheet).getCell('A2').value;
    expect(value).toBe('abcdefghijkl\tm\nn\ro');
  });

  it('keeps valid surrogate pairs next to stripped lone ones', async () => {
    const workbook = await load(build({}, [['😀\uD83Dx\uDE00😀', 'y']]));
    expect((workbook.getWorksheet('Messages') as ExcelJS.Worksheet).getCell('A2').value).toBe('😀x😀');
  });

  it('escapes literal "_xHHHH_" text so Excel does not decode it into other characters', () => {
    const xml = parts(build({}, [['_x000D_ _x0041_ _x005F_ _x12_ x000D_ _xZZZZ_', 'y']]))['xl/worksheets/sheet1.xml'];
    expect(xml).toContain('_x005F_x000D_ _x005F_x0041_ _x005F_x005F_ _x12_ x000D_ _xZZZZ_');
  });

  it('escapes every underscore that starts a literal "_xHHHH_", also when two of them share one', () => {
    const xml = parts(build({}, [['_x0041_x0042_', '_x0041_x0042_x0043_'], ['x_x000D_x000A_', '_x005F_x005F_']]))['xl/worksheets/sheet1.xml'];
    expect(xml).toContain('>_x005F_x0041_x005F_x0042_<');
    expect(xml).toContain('>_x005F_x0041_x005F_x0042_x005F_x0043_<');
    expect(xml).toContain('>x_x005F_x000D_x005F_x000A_<');
    expect(xml).toContain('>_x005F_x005F_x005F_x005F_<');
  });

  describe('read back the way Excel reads text (left-to-right "_xHHHH_" decoding)', () => {
    // exceljs hands out inline strings as stored, so this decoder stands in for the one in Excel (ST_Xstring).
    const decodeXstring = (text: string): string => text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

    async function readBack(texts: readonly string[]): Promise<(string | null)[]> {
      const workbook = await load(build({ columns: [{ header: 'A' }] }, texts.map((text) => [text])));
      const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
      return texts.map((_, i) => {
        const value = sheet.getCell(`A${i + 2}`).value;
        return typeof value === 'string' ? decodeXstring(value) : null;
      });
    }

    it('returns the original text for sequences that overlap or chain', async () => {
      const samples = ['_x0041_x0042_', '_x0041_x0042_x0043_', 'x_x000D_x000A_', '_x005F_x005F_', '_x005F_x0041_', '__x0041_', '_x0041__x0042_', 'a_x0041_b'];
      expect(await readBack(samples)).toEqual(samples);
    });

    it('returns the original text for random chains of escape-like fragments', async () => {
      // Whole sequences and fragments of them, so that sequences touch, overlap and share underscores often.
      const fragments = ['_x0041_', '_x000D_', '_x005F_', '_x00', 'x0042_', '0041_', '_', '_', 'x', '_x', 'a', 'F_'];
      let seed = 20260623;
      const next = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed >> 8;
      };
      const samples = Array.from({ length: 3000 }, () => Array.from({ length: 1 + (next() % 6) }, () => fragments[next() % fragments.length]).join(''));
      expect(samples.filter((s) => /_x[0-9A-Fa-f]{4}_x[0-9A-Fa-f]{4}_/.test(s)).length).toBeGreaterThan(100);
      const back = await readBack(samples);
      const wrong = samples.map((s, i) => ({ s, got: back[i] })).filter(({ s, got }) => got !== s);
      expect(wrong.slice(0, 5)).toEqual([]);
    });
  });

  it('drops cells that are empty after stripping', async () => {
    const xml = parts(build({}, [['\u0000\u0001', 'kept']]))['xl/worksheets/sheet1.xml'];
    expect(xml).not.toContain('r="A2"');
    expect(xml).toContain('r="B2"');
  });

  it('truncates cells at 32,767 characters and marks the cut', async () => {
    const long = 'x'.repeat(40_000);
    const exact = 'y'.repeat(32_767);
    const workbook = await load(build({}, [[long, exact]]));
    const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
    const a = sheet.getCell('A2').value as string;
    expect(a).toHaveLength(32_767);
    expect(a.endsWith('...[truncated]')).toBe(true);
    expect(a.startsWith('xxxx')).toBe(true);
    expect(sheet.getCell('B2').value).toBe(exact);
  });

  it('does not split a surrogate pair when truncating', async () => {
    const marker = '...[truncated]';
    const keep = 32_767 - marker.length;
    const input = `${'a'.repeat(keep - 1)}😀${'b'.repeat(100)}`; // the pair straddles the cut
    const workbook = await load(build({}, [[input, 'x']]));
    const value = (workbook.getWorksheet('Messages') as ExcelJS.Worksheet).getCell('A2').value as string;
    expect(value.length).toBeLessThanOrEqual(32_767);
    // The half-cut emoji is dropped entirely rather than left as a lone surrogate.
    expect(value).toBe(`${'a'.repeat(keep - 1)}${marker}`);
  });

  it('counts the limit after stripping illegal characters', async () => {
    const input = `${'\u0001'.repeat(5_000)}${'z'.repeat(32_767)}`;
    const workbook = await load(build({}, [[input, 'x']]));
    expect((workbook.getWorksheet('Messages') as ExcelJS.Worksheet).getCell('A2').value).toBe('z'.repeat(32_767));
  });

  it('writes xml:space="preserve" on every text cell', () => {
    const xml = parts(build({}, [[' padded ', 'b']]))['xl/worksheets/sheet1.xml'];
    const texts = xml.match(/<t[ >][^>]*>/g) ?? [];
    expect(texts.length).toBe(4);
    for (const t of texts) expect(t).toBe('<t xml:space="preserve">');
  });

  it('escapes headers like any other text', async () => {
    const workbook = await load(build({ columns: [{ header: 'A & <B>' }, { header: '이름' }] }, [['x', 'y']]));
    const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
    expect(sheet.getCell('A1').value).toBe('A & <B>');
    expect(sheet.getCell('B1').value).toBe('이름');
  });

  it('preserves row order across the internal segment boundary', async () => {
    const total = 1203;
    const builder = createXlsxBuilder({ sheetName: 'Big', columns: [{ header: 'i' }, { header: 't' }], createdAt: FIXED_DATE });
    for (let i = 1; i <= total; i += 1) builder.addRow([i, `row ${i}`]);
    const workbook = await load(builder.build());
    const sheet = workbook.getWorksheet('Big') as ExcelJS.Worksheet;
    expect(sheet.rowCount).toBe(total + 1);
    for (const i of [1, 499, 500, 501, 1000, 1001, 1203]) {
      expect(sheet.getCell(`A${i + 1}`).value).toBe(i);
      expect(sheet.getCell(`B${i + 1}`).value).toBe(`row ${i}`);
    }
  });
});

describe('columns', () => {
  it('addresses columns beyond Z correctly (AA, AZ, BA, ZZ, AAA)', async () => {
    const count = 703;
    const columns = Array.from({ length: count }, (_, i) => ({ header: `h${i + 1}` }));
    const row = columns.map((_, i) => `v${i + 1}`);
    const xlsx = build({ columns }, [row]);
    const xml = parts(xlsx)['xl/worksheets/sheet1.xml'];
    expect(xml).toContain('<dimension ref="A1:AAA2"/>');
    expect(xml).toContain('<autoFilter ref="A1:AAA2"/>');
    for (const [ref, text] of [
      ['A1', 'h1'],
      ['Z1', 'h26'],
      ['AA1', 'h27'],
      ['AZ1', 'h52'],
      ['BA1', 'h53'],
      ['ZZ1', 'h702'],
      ['AAA1', 'h703'],
      ['AAA2', 'v703'],
    ] as const) {
      expect(xml).toContain(`<c r="${ref}"`);
      const workbook = await load(xlsx);
      expect((workbook.getWorksheet('Messages') as ExcelJS.Worksheet).getCell(ref).value).toBe(text);
    }
  });

  it('applies widths, wrap alignment, top alignment and the header style', async () => {
    const workbook = await load(
      build({ columns: [{ header: 'When', width: 22 }, { header: 'Message', width: 80, wrap: true }, { header: 'Extra' }] }, [
        ['t', 'multi\nline', 'e'],
      ]),
    );
    const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
    expect(sheet.getColumn(1).width).toBe(22);
    expect(sheet.getColumn(2).width).toBe(80);

    const header = sheet.getCell('A1');
    expect(header.font?.bold).toBe(true);
    expect((header.fill as ExcelJS.FillPattern).pattern).toBe('solid');

    expect(sheet.getCell('A2').alignment?.vertical).toBe('top');
    expect(sheet.getCell('A2').alignment?.wrapText).toBeFalsy();
    expect(sheet.getCell('B2').alignment?.wrapText).toBe(true);
    expect(sheet.getCell('B2').alignment?.vertical).toBe('top');
    expect(sheet.getCell('C2').alignment?.wrapText).toBeFalsy();
  });

  it('clamps absurd widths and ignores invalid ones', () => {
    const xml = parts(
      build({ columns: [{ header: 'a', width: 9999 }, { header: 'b', width: -3 }, { header: 'c', width: Number.NaN }] }),
    )['xl/worksheets/sheet1.xml'];
    expect(xml).toContain('<cols><col min="1" max="1" width="255" customWidth="1"/></cols>');
  });

  it('freezes the header row and sets an autofilter', async () => {
    const workbook = await load(build({}, [['x', 'y'], ['z', 'w']]));
    const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1, topLeftCell: 'A2' });
    expect(sheet.autoFilter).toBe('A1:B3');
  });

  it('has a correct dimension for header-only, single-column and filled sheets', () => {
    const empty = parts(build({}))['xl/worksheets/sheet1.xml'];
    expect(empty).toContain('<dimension ref="A1:B1"/>');
    expect(empty).toContain('<autoFilter ref="A1:B1"/>');
    const single = parts(build({ columns: [{ header: 'only' }] }))['xl/worksheets/sheet1.xml'];
    expect(single).toContain('<dimension ref="A1"/>');
    const filled = parts(build({}, [['a', 'b'], ['c', 'd'], ['e', 'f']]))['xl/worksheets/sheet1.xml'];
    expect(filled).toContain('<dimension ref="A1:B4"/>');
  });

  it('opens a header-only workbook', async () => {
    const workbook = await load(build({}));
    const sheet = workbook.getWorksheet('Messages') as ExcelJS.Worksheet;
    expect(cellValues(sheet)).toEqual([['A', 'B']]);
  });

  it('rejects invalid configurations and over-wide rows', () => {
    expect(() => createXlsxBuilder({ sheetName: 'x', columns: [] })).toThrow(RangeError);
    expect(() => createXlsxBuilder({ sheetName: 'x', columns: Array.from({ length: 16_385 }, () => ({ header: 'h' })) })).toThrow(
      RangeError,
    );
    expect(() => createXlsxBuilder({ sheetName: 'x', columns: [{ header: 'h' }], maxRowsPerSheet: 1 })).toThrow(RangeError);
    expect(() => createXlsxBuilder({ sheetName: 'x', columns: [{ header: 'h' }], maxRowsPerSheet: 2.5 })).toThrow(RangeError);
    const builder = createXlsxBuilder({ sheetName: 'x', columns: [{ header: 'h' }] });
    expect(() => builder.addRow(['a', 'b'])).toThrow(RangeError);
    expect(builder.rowCount).toBe(0);
  });
});

describe('sheet splitting', () => {
  it('continues in "Name (2)", "Name (3)" with the header repeated', async () => {
    const builder = createXlsxBuilder({
      sheetName: 'Chat',
      columns: [{ header: 'n' }, { header: 'text' }],
      maxRowsPerSheet: 4, // header + 3 data rows
      createdAt: FIXED_DATE,
    });
    for (let i = 1; i <= 10; i += 1) builder.addRow([i, `m${i}`]);
    expect(builder.rowCount).toBe(10);

    const xlsx = builder.build();
    const files = parts(xlsx);
    expect(Object.keys(files).filter((n) => n.startsWith('xl/worksheets/'))).toHaveLength(4);
    for (const xml of Object.values(files)) expect(isWellFormed(xml)).toBe(true);

    const workbook = await load(xlsx);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Chat', 'Chat (2)', 'Chat (3)', 'Chat (4)']);
    const dump = workbook.worksheets.map(cellValues);
    expect(dump[0]).toEqual([['n', 'text'], [1, 'm1'], [2, 'm2'], [3, 'm3']]);
    expect(dump[1]).toEqual([['n', 'text'], [4, 'm4'], [5, 'm5'], [6, 'm6']]);
    expect(dump[2]).toEqual([['n', 'text'], [7, 'm7'], [8, 'm8'], [9, 'm9']]);
    expect(dump[3]).toEqual([['n', 'text'], [10, 'm10']]);
    workbook.worksheets.forEach((s) => expect(s.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 }));
  });

  it('does not create an extra sheet when the rows exactly fill one', async () => {
    const builder = createXlsxBuilder({ sheetName: 'Chat', columns: [{ header: 'n' }], maxRowsPerSheet: 3, createdAt: FIXED_DATE });
    builder.addRow([1]);
    builder.addRow([2]);
    const workbook = await load(builder.build());
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Chat']);
    builder.addRow([3]);
    expect((await load(builder.build())).worksheets.map((s) => s.name)).toEqual(['Chat', 'Chat (2)']);
  });

  it('selects only the first tab and keeps definedNames, sheetIds and relationships consistent', () => {
    const builder = createXlsxBuilder({ sheetName: 'S', columns: [{ header: 'n' }], maxRowsPerSheet: 2, createdAt: FIXED_DATE });
    for (let i = 0; i < 3; i += 1) builder.addRow([i]);
    const files = parts(builder.build());
    const selected = Object.entries(files).filter(([, xml]) => xml.includes('tabSelected="1"'));
    expect(selected.map(([name]) => name)).toEqual(['xl/worksheets/sheet1.xml']);

    const workbook = parse(files['xl/workbook.xml']);
    const sheets = Array.from(workbook.getElementsByTagName('sheet'));
    expect(sheets.map((s) => s.getAttribute('sheetId'))).toEqual(['1', '2', '3']);
    expect(sheets.map((s) => s.getAttribute('r:id'))).toEqual(['rId1', 'rId2', 'rId3']);
    const names = Array.from(workbook.getElementsByTagName('definedName'));
    expect(names.map((n) => n.getAttribute('localSheetId'))).toEqual(['0', '1', '2']);
    expect(names.map((n) => n.textContent)).toEqual(["'S'!$A$1:$A$2", "'S (2)'!$A$1:$A$2", "'S (3)'!$A$1:$A$2"]);
    expect(files['xl/_rels/workbook.xml.rels']).toContain('Id="rId4"');
  });

  it('keeps overflow sheet names within 31 characters', async () => {
    const builder = createXlsxBuilder({
      sheetName: 'A very long sheet name that exceeds the limit',
      columns: [{ header: 'n' }],
      maxRowsPerSheet: 2,
      createdAt: FIXED_DATE,
    });
    for (let i = 0; i < 12; i += 1) builder.addRow([i]);
    const names = (await load(builder.build())).worksheets.map((s) => s.name);
    expect(names).toHaveLength(12);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(12);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(31);
    expect(names[1]).toMatch(/ \(2\)$/);
    expect(names[11]).toMatch(/ \(12\)$/);
  });

  it('can build more than once and keep growing', async () => {
    const builder = createXlsxBuilder({ sheetName: 'S', columns: [{ header: 'n' }], createdAt: FIXED_DATE });
    builder.addRow([1]);
    const first = await load(builder.build());
    builder.addRow([2]);
    const second = await load(builder.build());
    expect(cellValues(first.worksheets[0])).toEqual([['n'], [1]]);
    expect(cellValues(second.worksheets[0])).toEqual([['n'], [1], [2]]);
  });
});

describe('sanitizeSheetName', () => {
  it('replaces characters Excel forbids', () => {
    expect(sanitizeSheetName('a[b]c:d*e?f/g\\h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('caps at 31 UTF-16 units without splitting surrogate pairs', () => {
    expect(sanitizeSheetName('x'.repeat(50))).toHaveLength(31);
    const out = sanitizeSheetName(`${'a'.repeat(30)}😀`);
    expect(out).toBe('a'.repeat(30));
    expect(sanitizeSheetName('😀'.repeat(20))).toBe('😀'.repeat(15));
  });

  it('trims apostrophes and whitespace at the edges but keeps inner ones', () => {
    expect(sanitizeSheetName("'quoted'")).toBe('quoted');
    expect(sanitizeSheetName("  it's  ")).toBe("it's");
  });

  it('never returns an empty name or the reserved name "History"', () => {
    expect(sanitizeSheetName('')).toBe('Sheet');
    expect(sanitizeSheetName("''")).toBe('Sheet');
    expect(sanitizeSheetName('History')).toBe('History_');
    expect(sanitizeSheetName('history')).toBe('history_');
    expect(sanitizeSheetName('Histories')).toBe('Histories');
  });

  it('removes control characters', () => {
    expect(sanitizeSheetName('a\u0000b\tc\nd')).toBe('ab c d');
  });

  it('keeps Korean names', () => {
    expect(sanitizeSheetName('메시지 목록')).toBe('메시지 목록');
  });

  it('is applied to the builder and reaches workbook.xml escaped', async () => {
    const xlsx = build({ sheetName: 'R&D <team>: "plan"' }, [['a', 'b']]);
    const workbook = await load(xlsx);
    expect(workbook.worksheets[0].name).toBe('R&D <team>_ "plan"');
    expect(isWellFormed(parts(xlsx)['xl/workbook.xml'])).toBe(true);
  });

  it('avoids "History" in the builder too', async () => {
    const workbook = await load(build({ sheetName: 'History' }, [['a', 'b']]));
    expect(workbook.worksheets[0].name).toBe('History_');
  });
});

describe('info sheet (build(info))', () => {
  const INFO = { name: 'Info', rows: [['Server', 'My Server'], ['Range', 'newest 200 messages']] as const };

  function buildWithInfo(info: XlsxInfoSheet | undefined, opts: Partial<XlsxBuilderOptions> = {}, rows: XlsxCell[][] = [['x', 'y']]): Uint8Array {
    const builder = createXlsxBuilder({ sheetName: 'Messages', columns: [{ header: 'A' }, { header: 'B' }], createdAt: FIXED_DATE, ...opts });
    rows.forEach((row) => builder.addRow(row));
    return builder.build(info);
  }

  it('is optional: without it the file is exactly what it was', () => {
    expect(Buffer.from(buildWithInfo(undefined)).equals(Buffer.from(build({}, [['x', 'y']])))).toBe(true);
    const files = parts(buildWithInfo(undefined));
    expect(Object.keys(files)).not.toContain('xl/worksheets/sheet2.xml');
  });

  it('adds one last worksheet of label | value rows, read back with ExcelJS', async () => {
    const workbook = await load(buildWithInfo(INFO));
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Messages', 'Info']);
    expect(cellValues(workbook.worksheets[1]!)).toEqual([
      ['Server', 'My Server'],
      ['Range', 'newest 200 messages'],
    ]);
    expect(cellValues(workbook.worksheets[0]!)).toEqual([['A', 'B'], ['x', 'y']]);
  });

  it('every part of the package is well-formed XML and the relationships are consistent', () => {
    const files = parts(buildWithInfo(INFO));
    for (const [name, xml] of Object.entries(files)) expect(isWellFormed(xml), name).toBe(true);
    expect(files['[Content_Types].xml']).toContain('PartName="/xl/worksheets/sheet2.xml"');
    expect(files['xl/_rels/workbook.xml.rels']).toContain('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"');
    expect(files['xl/_rels/workbook.xml.rels']).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"');
    expect(files['xl/workbook.xml']).toContain('<sheet name="Info" sheetId="2" r:id="rId2"/>');
  });

  it('comes after every sheet of a split table and is not part of the autofilter bookkeeping', async () => {
    const rows: XlsxCell[][] = Array.from({ length: 7 }, (_, i) => [`a${i}`, `b${i}`]);
    const xlsx = buildWithInfo(INFO, { maxRowsPerSheet: 4 }, rows); // 3 data rows per sheet => 3 data sheets
    const workbook = await load(xlsx);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Messages', 'Messages (2)', 'Messages (3)', 'Info']);
    const files = parts(xlsx);
    expect(Object.keys(files)).toContain('xl/worksheets/sheet4.xml');
    expect(files['xl/workbook.xml']!.match(/_xlnm\._FilterDatabase/g)).toHaveLength(3);
    expect(files['xl/_rels/workbook.xml.rels']).toMatch(/Id="rId5"[^>]*Target="styles\.xml"/);
  });

  it('gets a different name when it would clash with a data sheet (case-insensitively), and a legal one', async () => {
    expect((await load(buildWithInfo(INFO, { sheetName: 'info' }))).worksheets.map((s) => s.name)).toEqual(['info', 'Info (2)']);
    const odd = await load(buildWithInfo({ name: 'a/b:c*?[x]', rows: [['k', 'v']] }));
    expect(odd.worksheets[1]!.name).toBe(sanitizeSheetName('a/b:c*?[x]'));
    expect(odd.worksheets[1]!.name).not.toMatch(/[[\]:*?/\\]/);
    expect((await load(buildWithInfo({ name: 'History', rows: [] }))).worksheets[1]!.name).toBe('History_');
  });

  it('writes only string cells: markup, formulas and the "_xHHHH_" sequences are inert text', async () => {
    const hostile = '<b>=SUM(1)</b> & _x000D_ "q" \u0001';
    const xlsx = buildWithInfo({ name: 'Info', rows: [['=HYPERLINK("x")', hostile], ['@x', '+1']] });
    const files = parts(xlsx);
    expect(isWellFormed(files['xl/worksheets/sheet2.xml']!)).toBe(true);
    expect(files['xl/worksheets/sheet2.xml']).not.toContain('<f>');
    expect(files['xl/worksheets/sheet2.xml']).not.toMatch(/t="(?!inlineStr)[a-z]+"/);
    expect(files['xl/worksheets/sheet2.xml']).toContain('_x005F_x000D_');
    const sheet = (await load(xlsx)).worksheets[1]!;
    expect(sheet.getRow(1).getCell(1).value).toBe('=HYPERLINK("x")');
    // (ExcelJS hands the escaped text back as it is stored; Excel itself decodes "_x005F_" to the literal underscore)
    expect(String(sheet.getRow(1).getCell(2).value).startsWith('<b>=SUM(1)</b> & ')).toBe(true);
    expect(sheet.getRow(2).getCell(1).type).toBe(ExcelJS.ValueType.String);
  });

  it('caps a cell at Excel\'s 32,767 characters like every other cell', async () => {
    const sheet = (await load(buildWithInfo({ name: 'Info', rows: [['long', 'x'.repeat(40_000)]] }))).worksheets[1]!;
    const value = String(sheet.getRow(1).getCell(2).value);
    expect(value).toHaveLength(32_767);
    expect(value.endsWith('...[truncated]')).toBe(true);
  });

  it('empty values stay empty cells, an info sheet without rows is a valid empty sheet, and the sheet may be built repeatedly', async () => {
    const builder = createXlsxBuilder({ sheetName: 'Messages', columns: [{ header: 'A' }], createdAt: FIXED_DATE });
    builder.addRow(['x']);
    const first = builder.build({ name: 'Info', rows: [['', 'only a value'], ['only a label', '']] });
    const sheet = (await load(first)).worksheets[1]!;
    expect(cellValues(sheet)).toEqual([[undefined, 'only a value'], ['only a label']]);
    const empty = parts(builder.build({ name: 'Info', rows: [] }));
    expect(isWellFormed(empty['xl/worksheets/sheet2.xml']!)).toBe(true);
    expect(parts(builder.build())['xl/workbook.xml']).not.toContain('Info');
  });
});
