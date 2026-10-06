import type { ExportSettings } from '@/shared';
import { checkRange, endOfDayIso, isoToDateInput, startOfDayIso, type RangeFields, type RangeProblem } from '../format/dates';
import { MAX_COUNT } from '../platform/normalize';

/** What "개수 지정" starts with (the default of the common settings) and the quick-pick buttons next to the number. */
export const DEFAULT_COUNT = 200;
export const COUNT_CHIPS: readonly number[] = [100, 200, 500, 1000, 5000];
export { MAX_COUNT };

/**
 * What the text-like inputs of the settings panel show: the two dates as `<input type="date">` values plus the message count
 * as the user typed it. Everything else in `ExportSettings` (format, theme, the checkboxes) cannot be invalid and is edited
 * directly. The owner only ever receives settings that passed `checkFields` (docs/PLAN.md §7.3: count 1..1,000,000 whole
 * number, start <= end); anything else stays in these fields, is flagged in the panel, and blocks saving.
 * (Ported from v1's topbar/scopeFields.ts.)
 */
export interface Fields extends RangeFields {
  /** 'all' = no limit (`count: null`). */
  countMode: 'all' | 'limit';
  /** The count input's text while the mode is 'limit' ('' when empty). */
  countText: string;
}

/** empty: nothing typed; whole: not a whole number (decimals, exponent, text); range: a whole number outside 1..MAX_COUNT. */
export type CountProblem = 'empty' | 'whole' | 'range';

export interface FieldsProblem {
  range: RangeProblem | null;
  count: CountProblem | null;
}

const INTEGER = /^-?\d+$/;

export function fieldsOf(settings: Pick<ExportSettings, 'count' | 'from' | 'to'>): Fields {
  return {
    from: isoToDateInput(settings.from),
    to: isoToDateInput(settings.to),
    fromPartial: false,
    toPartial: false,
    countMode: settings.count === null ? 'all' : 'limit',
    countText: settings.count === null ? '' : String(settings.count),
  };
}

export function checkCountText(text: string): CountProblem | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty';
  if (!INTEGER.test(trimmed)) return 'whole';
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_COUNT ? null : 'range';
}

/** Why the fields cannot be exported as they are (null = they can). An empty date means "no bound", an empty count in 'all' mode is fine. */
export function checkFields(fields: Fields): FieldsProblem | null {
  const range = checkRange(fields);
  const count = fields.countMode === 'limit' ? checkCountText(fields.countText) : null;
  return range === null && count === null ? null : { range, count };
}

export function sameFields(a: Fields, b: Fields): boolean {
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.fromPartial === b.fromPartial &&
    a.toPartial === b.toPartial &&
    a.countMode === b.countMode &&
    a.countText === b.countText
  );
}

/** A deep copy: settings handed to the owner are never shared with the frozen defaults or with a store's state. */
export function cloneSettings(settings: ExportSettings): ExportSettings {
  return { ...settings, content: { ...settings.content } };
}

export function sameSettings(a: ExportSettings, b: ExportSettings): boolean {
  return (
    a.count === b.count &&
    a.from === b.from &&
    a.to === b.to &&
    a.format === b.format &&
    a.htmlTheme === b.htmlTheme &&
    a.includeAttachments === b.includeAttachments &&
    a.includeThreads === b.includeThreads &&
    a.incremental === b.incremental &&
    a.content.includeBots === b.content.includeBots &&
    a.content.includeSystem === b.content.includeSystem &&
    a.content.includeReactions === b.content.includeReactions &&
    a.content.includeEmbeds === b.content.includeEmbeds
  );
}

export type ParseResult = { ok: true; settings: ExportSettings } | { ok: false; problem: FieldsProblem };

/**
 * The settings that `fields` stand for on top of `base` (everything the fields do not cover is taken from `base`), or the
 * problem. A date that was not touched keeps its exact instant: an instant that does not sit on a day boundary is not rounded
 * just because the count changed. A changed day becomes the start (00:00:00.000) or the end (23:59:59.999) of that LOCAL day
 * (docs/PLAN.md §5.1).
 */
export function parseFields(fields: Fields, base: ExportSettings): ParseResult {
  const problem = checkFields(fields);
  if (problem !== null) return { ok: false, problem };
  const shown = fieldsOf(base);
  return {
    ok: true,
    settings: {
      ...cloneSettings(base),
      count: fields.countMode === 'limit' ? Number(fields.countText.trim()) : null,
      from: fields.from === shown.from ? base.from : startOfDayIso(fields.from),
      to: fields.to === shown.to ? base.to : endOfDayIso(fields.to),
    },
  };
}

/** Do any of the "더보기" options differ from the defaults? (The section starts open then, so a changed option is never hidden.) */
export function hasNonDefaultMoreOptions(settings: ExportSettings): boolean {
  return (
    settings.includeAttachments ||
    settings.includeThreads ||
    settings.incremental ||
    !settings.content.includeBots ||
    !settings.content.includeSystem ||
    !settings.content.includeReactions ||
    !settings.content.includeEmbeds
  );
}
