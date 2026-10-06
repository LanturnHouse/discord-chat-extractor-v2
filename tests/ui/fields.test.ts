import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from '@/shared';
import { endOfDayIso, startOfDayIso } from '@/ui/format/dates';
import {
  MAX_COUNT,
  checkCountText,
  checkFields,
  cloneSettings,
  fieldsOf,
  hasNonDefaultMoreOptions,
  parseFields,
  sameFields,
  sameSettings,
  type Fields,
} from '@/ui/settings/fields';

const base = (): ExportSettings => cloneSettings(DEFAULT_EXPORT_SETTINGS);
const fields = (patch: Partial<Fields> = {}): Fields => ({ ...fieldsOf(base()), ...patch });

describe('count validation (docs/PLAN.md §7.3: a whole number from 1 to 1,000,000)', () => {
  it('accepts the bounds and everything between', () => {
    for (const text of ['1', '200', '999999', String(MAX_COUNT), ' 42 ', '007']) expect(checkCountText(text), text).toBeNull();
  });

  it('refuses an empty field', () => {
    expect(checkCountText('')).toBe('empty');
    expect(checkCountText('   ')).toBe('empty');
  });

  it('refuses what is not a whole number', () => {
    for (const text of ['1.5', '1,000', '1e3', 'abc', '12abc', '٣', '+5', '5.']) expect(checkCountText(text), text).toBe('whole');
  });

  it('refuses a whole number outside the range', () => {
    for (const text of ['0', '-1', String(MAX_COUNT + 1), '99999999999999999999']) expect(checkCountText(text), text).toBe('range');
  });
});

describe('fieldsOf', () => {
  it('shows a count as text and "전체" as the all mode', () => {
    expect(fieldsOf({ count: 200, from: null, to: null })).toEqual({ from: '', to: '', fromPartial: false, toPartial: false, countMode: 'limit', countText: '200' });
    expect(fieldsOf({ count: null, from: null, to: null })).toMatchObject({ countMode: 'all', countText: '' });
  });

  it('shows the instants as local calendar days', () => {
    const shown = fieldsOf({ count: 5, from: startOfDayIso('2026-01-02'), to: endOfDayIso('2026-01-31') });
    expect([shown.from, shown.to]).toEqual(['2026-01-02', '2026-01-31']);
  });
});

describe('checkFields', () => {
  it('the defaults are fine', () => {
    expect(checkFields(fields())).toBeNull();
  });

  it('an empty count is only a problem in "개수 지정"', () => {
    expect(checkFields(fields({ countText: '' }))?.count).toBe('empty');
    expect(checkFields(fields({ countMode: 'all', countText: '' }))).toBeNull();
  });

  it('reports the range and the count problem independently', () => {
    const problem = checkFields(fields({ from: '2026-02-01', to: '2026-01-01', countText: '0' }));
    expect(problem?.range?.kind).toBe('inverted');
    expect(problem?.count).toBe('range');
  });

  it('start <= end: the same day is valid, an unfinished date is not', () => {
    expect(checkFields(fields({ from: '2026-01-05', to: '2026-01-05' }))).toBeNull();
    expect(checkFields(fields({ fromPartial: true }))?.range?.kind).toBe('invalid');
  });
});

describe('parseFields', () => {
  it('turns the days into the local start of the first and the local end of the last day', () => {
    const result = parseFields(fields({ from: '2026-01-02', to: '2026-01-31' }), base());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.from).toBe(new Date(2026, 0, 2, 0, 0, 0, 0).toISOString());
    expect(result.settings.to).toBe(new Date(2026, 0, 31, 23, 59, 59, 999).toISOString());
  });

  it('an empty day is no bound (null)', () => {
    const result = parseFields(fields({ from: '', to: '' }), { ...base(), from: startOfDayIso('2026-01-01'), to: endOfDayIso('2026-01-02') });
    expect(result.ok && [result.settings.from, result.settings.to]).toEqual([null, null]);
  });

  it('"전체" is count null, a number is that count', () => {
    const all = parseFields(fields({ countMode: 'all', countText: '' }), base());
    const some = parseFields(fields({ countText: ' 350 ' }), base());
    expect(all.ok && all.settings.count).toBeNull();
    expect(some.ok && some.settings.count).toBe(350);
  });

  it('keeps everything the fields do not cover from the base settings', () => {
    const own: ExportSettings = { ...base(), format: 'xlsx', htmlTheme: 'light', includeAttachments: true, content: { includeBots: false, includeSystem: true, includeReactions: false, includeEmbeds: true } };
    const result = parseFields(fields({ countText: '10' }), own);
    expect(result.ok && result.settings).toEqual({ ...own, count: 10 });
  });

  it('a date that was not touched keeps its exact instant (a count change does not round it to a day boundary)', () => {
    const odd = '2026-01-02T05:30:00.000Z';
    const settings: ExportSettings = { ...base(), from: odd };
    const result = parseFields({ ...fieldsOf(settings), countText: '10' }, settings);
    expect(result.ok && result.settings.from).toBe(odd);
  });

  it('a date that was changed becomes the day boundary, the other one stays as it was', () => {
    const odd = '2026-01-02T05:30:00.000Z';
    const settings: ExportSettings = { ...base(), from: odd, to: odd };
    const shown = fieldsOf(settings);
    const result = parseFields({ ...shown, to: '2026-02-01' }, settings);
    expect(result.ok && [result.settings.from, result.settings.to]).toEqual([odd, endOfDayIso('2026-02-01')]);
  });

  it('refuses an inverted range and a bad count', () => {
    expect(parseFields(fields({ from: '2026-02-01', to: '2026-01-01' }), base()).ok).toBe(false);
    expect(parseFields(fields({ countText: '0' }), base()).ok).toBe(false);
  });

  it('never shares objects with the base (frozen defaults included)', () => {
    const result = parseFields(fields(), DEFAULT_EXPORT_SETTINGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(result.settings).not.toBe(DEFAULT_EXPORT_SETTINGS);
    expect(result.settings.content).not.toBe(DEFAULT_EXPORT_SETTINGS.content);
    expect(Object.isFrozen(result.settings)).toBe(false);
  });
});

describe('helpers', () => {
  it('sameFields compares every field', () => {
    expect(sameFields(fields(), fields())).toBe(true);
    for (const patch of [{ from: '2026-01-01' }, { to: '2026-01-01' }, { fromPartial: true }, { toPartial: true }, { countMode: 'all' as const }, { countText: '1' }]) {
      expect(sameFields(fields(), fields(patch)), JSON.stringify(patch)).toBe(false);
    }
  });

  it('sameSettings compares every field, nested content included', () => {
    expect(sameSettings(base(), base())).toBe(true);
    const changes: Partial<ExportSettings>[] = [
      { count: 5 },
      { count: null },
      { from: '2026-01-01T00:00:00.000Z' },
      { to: '2026-01-01T00:00:00.000Z' },
      { format: 'csv' },
      { htmlTheme: 'light' },
      { includeAttachments: true },
      { includeThreads: true },
      { incremental: true },
      { content: { ...base().content, includeBots: false } },
      { content: { ...base().content, includeSystem: false } },
      { content: { ...base().content, includeReactions: false } },
      { content: { ...base().content, includeEmbeds: false } },
    ];
    for (const change of changes) expect(sameSettings(base(), { ...base(), ...change }), JSON.stringify(change)).toBe(false);
  });

  it('cloneSettings is deep enough: editing the copy never reaches the original', () => {
    const original = base();
    const copy = cloneSettings(original);
    copy.content.includeBots = false;
    copy.count = 1;
    expect(original.content.includeBots).toBe(true);
    expect(original.count).toBe(200);
  });

  it('"더보기" starts open only when an option in it differs from the defaults', () => {
    expect(hasNonDefaultMoreOptions(base())).toBe(false);
    expect(hasNonDefaultMoreOptions({ ...base(), includeAttachments: true })).toBe(true);
    expect(hasNonDefaultMoreOptions({ ...base(), includeThreads: true })).toBe(true);
    expect(hasNonDefaultMoreOptions({ ...base(), incremental: true })).toBe(true);
    expect(hasNonDefaultMoreOptions({ ...base(), content: { ...base().content, includeEmbeds: false } })).toBe(true);
  });
});
