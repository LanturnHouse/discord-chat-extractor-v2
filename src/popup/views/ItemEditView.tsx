import { useState, type ReactElement } from 'react';
import { resolveEffectiveSettings, type ExportSettings, type SettingsSource } from '@/shared';
import { Button } from '@/ui/components/Button';
import { formatTargetLabel, summarizeSettings } from '@/ui/format/summary';
import { summaryStrings } from '@/ui/format/strings';
import { commonStrings } from '@/ui/i18n/common';
import { useNumberFormat, useStrings } from '@/ui/i18n/locale';
import { sameSettings } from '@/ui/settings/fields';
import { SettingsPanel } from '@/ui/settings/SettingsPanel';
import { NoticeBar } from '../components/NoticeBar';
import { ViewHeader } from '../components/ViewHeader';
import { usePopupStore } from '../context';
import { popupStrings } from '../strings';

type ParentSource = Exclude<SettingsSource, 'item'>;

/**
 * One chat's own settings (docs/PLAN.md §7.2, the gear of a row): the settings panel of the common settings without the
 * language and ZIP rows, filled with the settings the chat has right now (its own, or the ones it follows: its category's, its
 * server's or the common ones). Edited as a draft: [저장] sends `queue/upsert` with the settings, [카테고리 / 서버 / 공통 설정으로
 * 되돌리기] (named after what the chat would follow again; only for a chat that has its own settings) sends it with
 * `settings: null`, [취소] sends nothing. Saving without a change sends nothing either: a chat nobody touched keeps following
 * what is above it.
 */
export function ItemEditView({ itemKey, onBack }: { itemKey: string; onBack: () => void }): ReactElement {
  const t = useStrings(popupStrings);
  const c = useStrings(commonStrings);
  const s = useStrings(summaryStrings);
  const fmt = useNumberFormat();
  const item = usePopupStore((state) => state.queue.find((entry) => entry.key === itemKey));
  const common = usePopupStore((state) => state.settings.common);
  const groups = usePopupStore((state) => state.groups);
  const groupSettings = usePopupStore((state) => state.groupSettings);
  const saveItem = usePopupStore((state) => state.saveItem);

  // The effective settings at the moment the editor opens: later changes of the settings above do not disturb the draft.
  const [initial] = useState<ExportSettings | null>(() => (item === undefined ? null : resolveEffectiveSettings(item, common, groupSettings, groups).settings));
  const [draft, setDraft] = useState<ExportSettings | null>(initial);
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);

  if (item === undefined || initial === null || draft === null) {
    return (
      <div className="dce-view dce-view--sheet">
        <ViewHeader title={t.editTitle} onBack={onBack} />
        <div className="dce-view__scroll dce-pad">
          <p className="dce-view__note">{t.editMissing}</p>
        </div>
        <footer className="dce-footer dce-footer--end">
          <Button variant="secondary" onClick={onBack}>
            {c.close}
          </Button>
        </footer>
      </div>
    );
  }

  const label = formatTargetLabel(item.target);
  const hasOwn = item.settings !== null;
  const dirty = !sameSettings(draft, initial);
  // What the chat follows (or would follow again after [되돌리기]): its category's settings, its server's, else the common ones.
  const parent = resolveEffectiveSettings({ ...item, settings: null }, common, groupSettings, groups);
  const parentSource = parent.source as ParentSource;
  const parentName = { common: t.parentCommon, guild: t.parentGuild, category: t.parentCategory }[parentSource];
  const revertLabel = { common: t.editRevert, guild: t.editRevertGuild, category: t.editRevertCategory }[parentSource];

  const submit = async (settings: ExportSettings | null): Promise<void> => {
    setBusy(true);
    const ok = await saveItem({ ...item, settings });
    setBusy(false);
    if (ok) onBack();
  };

  return (
    <div className="dce-view dce-view--sheet">
      <ViewHeader title={t.editTitle} subtitle={label} onBack={onBack} />
      <div className="dce-view__scroll dce-pad">
        <NoticeBar />
        <p className="dce-view__note">{hasOwn ? t.editHasOwn(parentName) : t.editFollows(parentName)}</p>
        {hasOwn ? <p className="dce-view__note">{t.editParentNow(parentName, summarizeSettings(parent.settings, s, fmt))}</p> : null}
        <SettingsPanel variant="item" value={draft} onChange={setDraft} onValidityChange={setValid} />
      </div>
      <footer className="dce-footer dce-footer--end">
        {hasOwn ? (
          <Button variant="link" className="dce-footer__revert" disabled={busy} onClick={() => void submit(null)}>
            {revertLabel}
          </Button>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          {c.cancel}
        </Button>
        <Button
          disabled={busy || !valid}
          title={valid ? undefined : t.editInvalid}
          onClick={() => {
            if (dirty) void submit(draft);
            else onBack();
          }}
        >
          {c.save}
        </Button>
      </footer>
    </div>
  );
}
