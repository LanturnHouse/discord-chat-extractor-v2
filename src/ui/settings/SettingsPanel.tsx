import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { EXPORT_FORMATS, type AppSettings, type ExportFormat, type ExportSettings } from '@/shared';
import { Checkbox } from '../components/Checkbox';
import { DateInput } from '../components/DateInput';
import { useLatest } from '../components/hooks';
import { ChevronDown, ChevronUp, Warning } from '../components/Icons';
import { NumberInput } from '../components/NumberInput';
import { RadioGroup, type RadioOption } from '../components/RadioGroup';
import { FORMAT_NAMES } from '../format/summary';
import { useNumberFormat, useStrings } from '../i18n/locale';
import {
  COUNT_CHIPS,
  DEFAULT_COUNT,
  MAX_COUNT,
  cloneSettings,
  fieldsOf,
  hasNonDefaultMoreOptions,
  parseFields,
  sameSettings,
  type CountProblem,
  type Fields,
} from './fields';
import { settingsStrings } from './strings';

interface PanelBase {
  /** The committed settings. The owner replaces it (synchronously) with every value passed to `onChange`. */
  value: ExportSettings;
  /**
   * Called with every complete, valid settings object that differs from `value`. A text field the user is still typing into
   * (an empty or out-of-range count, a start date after the end date) is NOT reported: it stays in the panel, flagged, and
   * `onValidityChange(false)` says so.
   */
  onChange: (next: ExportSettings) => void;
  /** Called with `false` while an input holds something that cannot be saved (and once with `true` when the panel appears). */
  onValidityChange?: (valid: boolean) => void;
}

/** The common settings: also holds the app-wide language and the "one ZIP" option, which only make sense there. */
export interface CommonPanelProps extends PanelBase {
  variant: 'common';
  language: AppSettings['language'];
  onLanguageChange: (language: AppSettings['language']) => void;
  zipAll: boolean;
  onZipAllChange: (zipAll: boolean) => void;
}

/** One chat's own settings (the item's gear): the same fields, without the language and ZIP rows. */
export interface ItemPanelProps extends PanelBase {
  variant: 'item';
}

export type SettingsPanelProps = CommonPanelProps | ItemPanelProps;

type DescriptionKey = 'descHtml' | 'descTxt' | 'descMd' | 'descXlsx' | 'descCsv' | 'descJson';
const DESCRIPTION_KEYS: Record<ExportFormat, DescriptionKey> = {
  html: 'descHtml',
  txt: 'descTxt',
  md: 'descMd',
  xlsx: 'descXlsx',
  csv: 'descCsv',
  json: 'descJson',
};

// Endonyms: each language is named in itself, whatever the UI language is.
const LANGUAGE_NAMES = { ko: '한국어', en: 'English' } as const;

/**
 * The settings panel (docs/PLAN.md §7.3), the look of v1's export options popover: format cards (+ the HTML theme), the number
 * of messages, the date range, a "더보기" section for the extras, and (common variant only) the language and "ZIP 하나로 받기".
 * The common variant is saved by its owner on every change; the item variant is edited as a draft and saved with a button.
 *
 * It keeps what the user is typing in the count and date inputs itself and reports only valid, complete settings; every other
 * field is read from `value`, so the owner stays the single source of truth.
 */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const { value, onChange, onValidityChange } = props;
  const t = useStrings(settingsStrings);
  const fmt = useNumberFormat();

  const [fields, setFields] = useState<Fields>(() => fieldsOf(value));
  const parsed = useMemo(() => parseFields(fields, value), [fields, value]);
  const [moreOpen, setMoreOpen] = useState(() => hasNonDefaultMoreOptions(value));

  // `value` changed under us (the owner reverted, or storage changed): show it. Not when it is just the echo of what the
  // fields already say - that would throw away how the user typed it ("012").
  const lastValue = useRef(value);
  useEffect(() => {
    if (sameSettings(lastValue.current, value)) return;
    lastValue.current = value;
    if (parsed.ok && sameSettings(parsed.settings, value)) return;
    setFields(fieldsOf(value));
  }, [value, parsed]);

  const valid = parsed.ok;
  const latestValidity = useLatest(onValidityChange);
  useEffect(() => {
    latestValidity.current?.(valid);
  }, [valid, latestValidity]);

  const emit = (next: ExportSettings): void => {
    if (!sameSettings(next, value)) onChange(cloneSettings(next));
  };
  const setOption = (patch: Partial<ExportSettings>): void => emit({ ...cloneSettings(value), ...patch });
  const setContent = (patch: Partial<ExportSettings['content']>): void => emit({ ...cloneSettings(value), content: { ...value.content, ...patch } });
  const editFields = (patch: Partial<Fields>): void => {
    const next = { ...fields, ...patch };
    setFields(next);
    const result = parseFields(next, value);
    if (result.ok) emit(result.settings);
  };

  const rangeErrorId = useId();
  const countErrorId = useId();
  const countHelpId = useId();
  const morePanelId = useId();
  const problem = parsed.ok ? null : parsed.problem;
  const hasFrom = fields.from !== '' && !fields.fromPartial;
  const hasTo = fields.to !== '' && !fields.toPartial;
  const countProblem = problem?.count ?? null;
  const countNumber = fields.countMode === 'limit' && countProblem === null ? Number(fields.countText.trim()) : null;

  // Where "개수 지정" starts when the user switches back to it: the number it had before "전체" was chosen.
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    if (value.count !== null) lastCount.current = value.count;
  }, [value.count]);

  const formatOptions = useMemo<RadioOption<ExportFormat>[]>(
    () => EXPORT_FORMATS.map((id) => ({ value: id, label: FORMAT_NAMES[id], description: t[DESCRIPTION_KEYS[id]] })),
    [t],
  );
  const themeOptions = useMemo<RadioOption<ExportSettings['htmlTheme']>[]>(
    () => [
      { value: 'dark', label: t.themeDark },
      { value: 'light', label: t.themeLight },
    ],
    [t],
  );
  const modeOptions = useMemo<RadioOption<Fields['countMode']>[]>(
    () => [
      { value: 'limit', label: t.countModeLimit },
      { value: 'all', label: t.countModeAll },
    ],
    [t],
  );
  const languageOptions = useMemo<RadioOption<AppSettings['language']>[]>(
    () => [
      { value: 'auto', label: t.languageAuto },
      { value: 'ko', label: LANGUAGE_NAMES.ko },
      { value: 'en', label: LANGUAGE_NAMES.en },
    ],
    [t],
  );

  const chooseMode = (mode: Fields['countMode']): void => {
    if (mode === 'all') editFields({ countMode: 'all', countText: '' });
    else editFields({ countMode: 'limit', countText: String(lastCount.current ?? DEFAULT_COUNT) });
  };

  const countMessage = (kind: CountProblem): string => (kind === 'empty' ? t.countEmpty : kind === 'whole' ? t.countWhole : t.countRange(MAX_COUNT, fmt));
  const countHint =
    fields.countMode === 'all'
      ? { text: hasFrom || hasTo ? t.countAllInRange : t.countAllWarning, warning: !(hasFrom || hasTo) }
      : countNumber === null
        ? null
        : { text: hasFrom || hasTo ? t.countHelpInRange(countNumber, fmt) : t.countHelpNewest(countNumber, fmt), warning: false };

  return (
    <div className="dce-sp" data-variant={props.variant}>
      <section className="dce-sp__section">
        <h3 className="dce-sp__heading">{t.formatLabel}</h3>
        <RadioGroup variant="cards" label={t.formatLabel} value={value.format} options={formatOptions} onChange={(format) => setOption({ format })} />
        {value.format === 'html' ? (
          <div className="dce-sp__theme">
            <span className="dce-sp__theme-label">{t.themeLabel}</span>
            <RadioGroup variant="segmented" label={t.themeLabel} value={value.htmlTheme} options={themeOptions} onChange={(htmlTheme) => setOption({ htmlTheme })} />
          </div>
        ) : null}
      </section>

      <section className="dce-sp__section">
        <h3 className="dce-sp__heading">{t.countLabel}</h3>
        <RadioGroup variant="segmented" label={t.countLabel} value={fields.countMode} options={modeOptions} onChange={chooseMode} />
        {fields.countMode === 'limit' ? (
          <div className="dce-sp__count">
            <NumberInput
              value={fields.countText}
              onChange={(countText) => editFields({ countMode: 'limit', countText })}
              min={1}
              max={MAX_COUNT}
              label={t.countInputLabel}
              unit={t.countUnit}
              invalid={countProblem !== null}
              describedBy={countProblem === null ? countHelpId : countErrorId}
            />
            <div role="group" aria-label={t.quickPicks} className="dce-sp__chips">
              {COUNT_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="dce-sp__chip"
                  aria-pressed={countNumber === chip}
                  onClick={() => editFields({ countMode: 'limit', countText: String(chip) })}
                >
                  {fmt(chip)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {countProblem !== null ? (
          <p id={countErrorId} role="alert" className="dce-sp__error">
            {countMessage(countProblem)}
          </p>
        ) : countHint === null ? null : (
          <p id={countHelpId} className={countHint.warning ? 'dce-sp__note dce-sp__note--warning' : 'dce-sp__help'}>
            {countHint.warning ? <Warning /> : null}
            <span>{countHint.text}</span>
          </p>
        )}
      </section>

      <section className="dce-sp__section">
        <h3 className="dce-sp__heading">{t.rangeLabel}</h3>
        <div className="dce-sp__range">
          <DateInput
            label={t.fromLabel}
            clearLabel={t.clearFrom}
            value={fields.from}
            partial={fields.fromPartial}
            invalid={problem?.range?.from === true}
            describedBy={rangeErrorId}
            onChange={(from, fromPartial) => editFields({ from, fromPartial })}
          />
          <DateInput
            label={t.toLabel}
            clearLabel={t.clearTo}
            value={fields.to}
            partial={fields.toPartial}
            invalid={problem?.range?.to === true}
            describedBy={rangeErrorId}
            onChange={(to, toPartial) => editFields({ to, toPartial })}
          />
        </div>
        {problem?.range == null ? null : (
          <p id={rangeErrorId} role="alert" className="dce-sp__error">
            {problem.range.kind === 'inverted' ? t.invalidRange : t.invalidDate}
          </p>
        )}
        <p className="dce-sp__help">{t.rangeHelp}</p>
      </section>

      <section className="dce-sp__section">
        <button
          type="button"
          className="dce-sp__more"
          aria-expanded={moreOpen}
          aria-controls={moreOpen ? morePanelId : undefined}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <span>{t.moreLabel}</span>
          {moreOpen ? <ChevronUp /> : <ChevronDown />}
        </button>
        {moreOpen ? (
          <div id={morePanelId} className="dce-sp__more-body">
            <Checkbox
              checked={value.includeAttachments}
              onChange={(includeAttachments) => setOption({ includeAttachments })}
              label={t.optAttachments}
              description={t.optAttachmentsHelp}
            />
            <Checkbox checked={value.includeThreads} onChange={(includeThreads) => setOption({ includeThreads })} label={t.optThreads} description={t.optThreadsHelp} />
            {value.includeThreads ? (
              <p role="status" className="dce-sp__note dce-sp__note--warning">
                <Warning />
                <span>{t.optThreadsWarning}</span>
              </p>
            ) : null}
            <Checkbox checked={value.incremental} onChange={(incremental) => setOption({ incremental })} label={t.optIncremental} description={t.optIncrementalHelp} />
            {value.incremental && value.count !== null ? (
              <p role="status" className="dce-sp__note dce-sp__note--warning">
                <Warning />
                <span>{t.optIncrementalGap(value.count, fmt)}</span>
              </p>
            ) : null}
            <div role="group" aria-label={t.contentLabel} className="dce-sp__group">
              <h4 className="dce-sp__subheading">{t.contentLabel}</h4>
              <Checkbox checked={value.content.includeBots} onChange={(includeBots) => setContent({ includeBots })} label={t.optBots} />
              <Checkbox checked={value.content.includeSystem} onChange={(includeSystem) => setContent({ includeSystem })} label={t.optSystem} />
              <Checkbox checked={value.content.includeReactions} onChange={(includeReactions) => setContent({ includeReactions })} label={t.optReactions} />
              <Checkbox checked={value.content.includeEmbeds} onChange={(includeEmbeds) => setContent({ includeEmbeds })} label={t.optEmbeds} />
            </div>
          </div>
        ) : null}
      </section>

      {props.variant === 'common' ? (
        <>
          <section className="dce-sp__section">
            <h3 className="dce-sp__heading">{t.languageLabel}</h3>
            <RadioGroup variant="segmented" label={t.languageLabel} value={props.language} options={languageOptions} onChange={props.onLanguageChange} />
            <p className="dce-sp__help">{t.languageHelp}</p>
          </section>
          <section className="dce-sp__section">
            <Checkbox checked={props.zipAll} onChange={props.onZipAllChange} label={t.zipLabel} description={t.zipHelp} />
          </section>
        </>
      ) : null}
    </div>
  );
}
