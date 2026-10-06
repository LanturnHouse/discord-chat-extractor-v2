import { useEffect, useState, type ReactElement } from 'react';
import { LOCAL, type AppSettings, type ToBackground } from '@/shared';
import { MOCK_SCENARIOS, sampleTheme, type MockPlatform, type MockScenario } from '@/ui/platform/mock';
import { normalizeSettings } from '@/ui/platform/normalize';
import { PopupRoot } from '../PopupRoot';

/** The preview polls faster than the real popup (2 s) so a switched scenario shows what only `status/get` reports (tabs, page health) at once. */
const PREVIEW_POLL_MS = 500;

/** The messages that are not worth listing: the poll answers all the time. */
const NOISE: ReadonlySet<ToBackground['type']> = new Set(['status/get']);

function describe(message: ToBackground): string {
  switch (message.type) {
    case 'settings/patch':
      return `settings/patch ${JSON.stringify(message.patch)}`;
    case 'job/start':
      return `job/start ${JSON.stringify(message.keys)}`;
    case 'queue/upsert':
      return `queue/upsert ${message.item.key} settings=${message.item.settings === null ? 'null' : 'own'}`;
    case 'queue/remove':
      return `queue/remove ${message.key}`;
    case 'queue/removeMany':
      return `queue/removeMany ${JSON.stringify(message.keys)}`;
    case 'queue/setGroupSettings':
      return `queue/setGroupSettings ${message.kind} ${message.groupId} settings=${message.settings === null ? 'null' : 'own'}`;
    case 'history/rerun':
      return `history/rerun ${message.id}`;
    case 'downloads/show':
      return `downloads/show ${String(message.downloadId)}`;
    default:
      return message.type;
  }
}

/**
 * The preview page around the popup (only `popup.html?mock=1`, never in a real extension): the popup in a 380 x 600 frame next
 * to a few controls - scenario, theme, language - and the list of the messages the popup has sent to the (mock) background.
 */
export function PreviewShell({ platform, initialScenario }: { platform: MockPlatform; initialScenario: MockScenario }): ReactElement {
  const [scenario, setScenario] = useState<MockScenario>(initialScenario);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      setLog(platform.sent.filter((message) => !NOISE.has(message.type)).slice(-12).map(describe));
    }, 400);
    return () => clearInterval(timer);
  }, [platform]);

  const changeScenario = (next: MockScenario): void => {
    setScenario(next);
    platform.load(next);
  };
  const changeTheme = (scheme: 'dark' | 'light'): void => {
    platform.write('local', { [LOCAL.theme]: sampleTheme(scheme, Date.now()) });
  };
  const changeLanguage = (language: AppSettings['language']): void => {
    const settings = normalizeSettings(platform.read('local', LOCAL.settings));
    platform.write('local', { [LOCAL.settings]: { ...settings, language } });
  };

  return (
    <div className="dce-preview">
      <div className="dce-preview__frame">
        <PopupRoot platform={platform} pollMs={PREVIEW_POLL_MS} />
      </div>
      <aside className="dce-preview__controls" aria-label="Mock preview controls">
        <h2>Mock preview</h2>
        <p>The popup runs on an in-memory mock of the extension. Nothing here is real.</p>
        <label>
          Scenario
          <select value={scenario} onChange={(event) => changeScenario(event.currentTarget.value as MockScenario)}>
            {MOCK_SCENARIOS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Theme
          <select defaultValue="dark" onChange={(event) => changeTheme(event.currentTarget.value === 'light' ? 'light' : 'dark')}>
            <option value="dark">dark</option>
            <option value="light">light</option>
          </select>
        </label>
        <label>
          Language
          <select defaultValue="auto" onChange={(event) => changeLanguage(event.currentTarget.value === 'ko' ? 'ko' : event.currentTarget.value === 'en' ? 'en' : 'auto')}>
            <option value="auto">auto</option>
            <option value="ko">ko</option>
            <option value="en">en</option>
          </select>
        </label>
        <h3>Messages sent</h3>
        <ol className="dce-preview__log">
          {log.length === 0 ? <li>(none yet)</li> : log.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
        </ol>
      </aside>
    </div>
  );
}
