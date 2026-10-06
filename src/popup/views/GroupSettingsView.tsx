import { useMemo, useState, type ReactElement } from 'react';
import type { ExportSettings } from '@/shared';
import { Button } from '@/ui/components/Button';
import { Info } from '@/ui/components/Icons';
import { commonStrings } from '@/ui/i18n/common';
import { useNumberFormat, useStrings } from '@/ui/i18n/locale';
import { sameSettings } from '@/ui/settings/fields';
import { SettingsPanel } from '@/ui/settings/SettingsPanel';
import { NoticeBar } from '../components/NoticeBar';
import { ViewHeader } from '../components/ViewHeader';
import { usePopupStore } from '../context';
import { popupStrings } from '../strings';
import { describeGroup } from '../tree/buildQueueTree';

export interface GroupSettingsViewProps {
  /** A server (`groupId` = its id) or a category (`groupId` = its id). */
  kind: 'guild' | 'category';
  groupId: string;
  onBack: () => void;
}

/**
 * The settings of one server or category (docs/PLAN.md §7.2a, the gear of a group line): the settings panel of a chat's own
 * settings (no language, no ZIP), filled with what the chats of the group follow now. Edited as a draft. Before saving it says how
 * many settings of chats below (and, for a server, of its categories) the save replaces. [저장] sends `queue/setGroupSettings`
 * with the settings, [상위 설정으로 되돌리기] (only when the group has settings of its own) sends it with `settings: null` - that
 * removes the group's settings and leaves the settings of the chats alone - and [취소] sends nothing.
 */
export function GroupSettingsView({ kind, groupId, onBack }: GroupSettingsViewProps): ReactElement {
  const t = useStrings(popupStrings);
  const c = useStrings(commonStrings);
  const fmt = useNumberFormat();
  const queue = usePopupStore((state) => state.queue);
  const groups = usePopupStore((state) => state.groups);
  const groupSettings = usePopupStore((state) => state.groupSettings);
  const common = usePopupStore((state) => state.settings.common);
  const saveGroupSettings = usePopupStore((state) => state.saveGroupSettings);

  // Worked out from the state as it is now, so the count and the note follow changes made while the screen is open.
  const group = useMemo(
    () => describeGroup(kind, groupId, { items: queue, groups, groupSettings, common, fallbackNames: { guild: t.unknownServer, category: t.unknownCategory } }),
    [kind, groupId, queue, groups, groupSettings, common, t],
  );

  // What the group's chats follow at the moment the editor opens: later changes to the settings above do not disturb the draft.
  const [initial] = useState<ExportSettings | null>(() => group?.effective ?? null);
  const [draft, setDraft] = useState<ExportSettings | null>(initial);
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);

  if (group === null || initial === null || draft === null) {
    return (
      <div className="dce-view dce-view--sheet">
        <ViewHeader title={kind === 'guild' ? t.parentGuild : t.parentCategory} onBack={onBack} />
        <div className="dce-view__scroll dce-pad">
          <p className="dce-view__note">{t.groupMissing}</p>
        </div>
        <footer className="dce-footer dce-footer--end">
          <Button variant="secondary" onClick={onBack}>
            {c.close}
          </Button>
        </footer>
      </div>
    );
  }

  const hasOwn = group.ownSettings !== null;
  const replaced = group.overrides.itemKeys.length + group.overrides.categoryIds.length;
  const dirty = !sameSettings(draft, initial);
  const title = kind === 'guild' ? t.guildSettingsTitle(group.name) : t.categorySettingsTitle(group.name);

  const submit = async (settings: ExportSettings | null): Promise<void> => {
    setBusy(true);
    const ok = await saveGroupSettings(kind, group.guildId, groupId, settings);
    setBusy(false);
    if (ok) onBack();
  };

  return (
    <div className="dce-view dce-view--sheet">
      <ViewHeader title={title} subtitle={t.groupAppliesTo(group.keys.length, fmt)} onBack={onBack} />
      <div className="dce-view__scroll dce-pad">
        <NoticeBar />
        <p className="dce-view__note">{hasOwn ? t.groupNoteOwn : t.groupNoteNew}</p>
        {replaced > 0 ? (
          <div className="dce-banner dce-banner--warning" role="status" data-group-overrides={replaced}>
            <span className="dce-banner__icon">
              <Info />
            </span>
            <div className="dce-banner__text">
              <span>{t.groupOverridesNotice(replaced, fmt)}</span>
            </div>
          </div>
        ) : null}
        <SettingsPanel variant="item" value={draft} onChange={setDraft} onValidityChange={setValid} />
      </div>
      <footer className="dce-footer dce-footer--end">
        {hasOwn ? (
          <Button variant="link" className="dce-footer__revert" disabled={busy} title={t.groupRevertTitle} onClick={() => void submit(null)}>
            {t.groupRevert}
          </Button>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          {c.cancel}
        </Button>
        <Button
          disabled={busy || !valid}
          title={valid ? undefined : t.editInvalid}
          onClick={() => {
            // Nothing changed and nothing below would be replaced: there is nothing to save.
            if (dirty || replaced > 0) void submit(draft);
            else onBack();
          }}
        >
          {c.save}
        </Button>
      </footer>
    </div>
  );
}
