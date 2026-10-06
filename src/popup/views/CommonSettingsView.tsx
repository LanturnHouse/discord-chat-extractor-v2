import type { ReactElement } from 'react';
import { SettingsPanel } from '@/ui/settings/SettingsPanel';
import { useStrings } from '@/ui/i18n/locale';
import { NoticeBar } from '../components/NoticeBar';
import { ViewHeader } from '../components/ViewHeader';
import { usePopupStore } from '../context';
import { popupStrings } from '../strings';

/**
 * The common settings (docs/PLAN.md §7.3), opened by the caret of the download button: v1's export options panel. Every change
 * is sent to the background worker right away (`settings/patch`: `common` as a whole, `language`, `zipAll`); there is no save button.
 */
export function CommonSettingsView({ onBack }: { onBack: () => void }): ReactElement {
  const t = useStrings(popupStrings);
  const settings = usePopupStore((state) => state.settings);
  const patchSettings = usePopupStore((state) => state.patchSettings);
  return (
    <div className="dce-view dce-view--sheet">
      <ViewHeader title={t.commonSettingsTitle} onBack={onBack} />
      <div className="dce-view__scroll dce-pad">
        <NoticeBar />
        <p className="dce-view__note">{t.commonSettingsNote}</p>
        <SettingsPanel
          variant="common"
          value={settings.common}
          onChange={(common) => void patchSettings({ common })}
          language={settings.language}
          onLanguageChange={(language) => void patchSettings({ language })}
          zipAll={settings.zipAll}
          onZipAllChange={(zipAll) => void patchSettings({ zipAll })}
        />
      </div>
    </div>
  );
}
