import { useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import { Button } from '@/ui/components/Button';
import { External } from '@/ui/components/Icons';
import { Toggle } from '@/ui/components/Toggle';
import { browserTimeZone, supportedTimeZones } from '@/ui/format/time';
import { useLatest } from '@/ui/components/hooks';
import { useNumberFormat, useStrings } from '@/ui/i18n/locale';
import type { ShortcutInfo } from '@/ui/platform/types';
import { NoticeBar } from '../components/NoticeBar';
import { ViewHeader } from '../components/ViewHeader';
import { usePlatform, usePopupStore } from '../context';
import { appSettingsStrings } from '../strings';

/** The name of the command the content script and the background worker agree on (docs/PLAN.md §7.1 #15). */
export const ADD_CURRENT_COMMAND = 'add-current-chat';

export const MAX_FOLDER_NAME_LENGTH = 80;
// What no file system accepts in a folder name; the background worker cleans the name once more (docs/PLAN.md §6.6).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_FOLDER_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

export type FolderProblem = 'empty' | 'long' | 'chars';

export function checkFolderName(name: string): FolderProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'empty';
  if (Array.from(trimmed).length > MAX_FOLDER_NAME_LENGTH) return 'long';
  return FORBIDDEN_FOLDER_CHARS.test(trimmed) ? 'chars' : null;
}

/** The folder name field: what is typed is saved when the field is left, on Enter, and when the screen closes - never half-way. */
function FolderField({ value, onCommit }: { value: string; onCommit: (name: string) => void }): ReactElement {
  const t = useStrings(appSettingsStrings);
  const fmt = useNumberFormat();
  const [text, setText] = useState(value);
  const problem = checkFolderName(text);
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  useEffect(() => setText(value), [value]);

  const commit = (): void => {
    const next = text.trim();
    if (problem === null && next !== value) onCommit(next);
  };
  const latestCommit = useLatest(commit);
  useEffect(() => () => latestCommit.current(), [latestCommit]);

  const message = problem === 'empty' ? t.folderEmpty : problem === 'long' ? t.folderTooLong(MAX_FOLDER_NAME_LENGTH, fmt) : problem === 'chars' ? t.folderInvalid : null;
  return (
    <div className="dce-field">
      <label className="dce-field__label" htmlFor={id}>
        {t.folderLabel}
      </label>
      <input
        id={id}
        type="text"
        className="dce-field__input"
        value={text}
        maxLength={MAX_FOLDER_NAME_LENGTH}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={problem === null ? undefined : true}
        aria-describedby={problem === null ? helpId : errorId}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      {message === null ? (
        <p id={helpId} className="dce-field__help">
          {t.folderHelp}
        </p>
      ) : (
        <p id={errorId} role="alert" className="dce-field__error">
          {message}
        </p>
      )}
    </div>
  );
}

function TimeZoneField({ value, onChange }: { value: string; onChange: (zone: string) => void }): ReactElement {
  const t = useStrings(appSettingsStrings);
  const id = useId();
  const zones = useMemo(() => {
    const known = supportedTimeZones();
    // `Intl.supportedValuesOf` leaves out "UTC" in some engines, and a stored zone this browser does not list must stay selectable.
    const all = new Set(['UTC', ...known]);
    if (value !== 'auto') all.add(value);
    return [...all].sort((a, b) => a.localeCompare(b, 'en'));
  }, [value]);
  return (
    <div className="dce-field">
      <label className="dce-field__label" htmlFor={id}>
        {t.timeZoneLabel}
      </label>
      <select id={id} className="dce-field__select" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        <option value="auto">{t.timeZoneAuto(browserTimeZone())}</option>
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </select>
      <p className="dce-field__help">{t.timeZoneHelp}</p>
    </div>
  );
}

function ShortcutRow(): ReactElement {
  const t = useStrings(appSettingsStrings);
  const platform = usePlatform();
  const [shortcut, setShortcut] = useState<ShortcutInfo | null | undefined>(undefined);
  const labelId = useId();

  useEffect(() => {
    let cancelled = false;
    void platform.getShortcuts().then((commands) => {
      if (!cancelled) setShortcut(commands.find((command) => command.name === ADD_CURRENT_COMMAND) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const keys = shortcut?.shortcut.trim() ?? '';
  return (
    <div className="dce-field">
      <span className="dce-field__label" id={labelId}>
        {t.shortcutLabel}
      </span>
      <div className="dce-shortcut">
        <span className="dce-shortcut__keys" role="group" aria-labelledby={labelId}>
          {shortcut === undefined ? '…' : keys === '' ? t.shortcutNone : keys.split('+').map((key) => <kbd key={key}>{key}</kbd>)}
        </span>
        <Button variant="secondary" size="sm" icon={<External />} onClick={() => void platform.openShortcutSettings()}>
          {t.shortcutChange}
        </Button>
      </div>
      <p className="dce-field__help">{t.shortcutHelp}</p>
    </div>
  );
}

/**
 * The app settings (docs/PLAN.md §7.2, the gear of the header): the folder name, the date in file names, the time zone
 * ('auto' + every IANA zone the browser knows), the completion notification, the keyboard shortcut (shown from
 * `chrome.commands`, changed on chrome://extensions/shortcuts) and the first-run notice again. Every change is sent at once
 * (`settings/patch`). There is no "always show queued chats" option (#17, retired in the 4th change: the row buttons are always
 * visible); `settings.showQueuedIndicator` stays in storage but nothing here reads or writes it.
 */
export function AppSettingsView({ onBack, onShowConsent }: { onBack: () => void; onShowConsent: () => void }): ReactElement {
  const t = useStrings(appSettingsStrings);
  const settings = usePopupStore((state) => state.settings);
  const patchSettings = usePopupStore((state) => state.patchSettings);
  return (
    <div className="dce-view dce-view--sheet">
      <ViewHeader title={t.title} onBack={onBack} />
      <div className="dce-view__scroll dce-pad">
        <NoticeBar />
        <section className="dce-section" aria-labelledby="dce-sec-files">
          <h2 className="dce-section__title" id="dce-sec-files">
            {t.sectionFiles}
          </h2>
          <FolderField value={settings.folderName} onCommit={(folderName) => void patchSettings({ folderName })} />
          <Toggle
            checked={settings.dateInFileName}
            onChange={(dateInFileName) => void patchSettings({ dateInFileName })}
            label={t.dateInFileName}
            description={t.dateInFileNameHelp}
          />
          <TimeZoneField value={settings.timeZone} onChange={(timeZone) => void patchSettings({ timeZone })} />
        </section>
        <section className="dce-section" aria-labelledby="dce-sec-notify">
          <h2 className="dce-section__title" id="dce-sec-notify">
            {t.sectionNotify}
          </h2>
          <Toggle checked={settings.notifyOnComplete} onChange={(notifyOnComplete) => void patchSettings({ notifyOnComplete })} label={t.notifyOnComplete} />
        </section>
        <section className="dce-section" aria-labelledby="dce-sec-shortcut">
          <h2 className="dce-section__title" id="dce-sec-shortcut">
            {t.sectionShortcut}
          </h2>
          <ShortcutRow />
        </section>
        <section className="dce-section" aria-labelledby="dce-sec-notice">
          <h2 className="dce-section__title" id="dce-sec-notice">
            {t.sectionNotice}
          </h2>
          <Button variant="secondary" className="dce-section__button" data-focus-id="show-consent" onClick={onShowConsent}>
            {t.showConsent}
          </Button>
        </section>
      </div>
    </div>
  );
}
