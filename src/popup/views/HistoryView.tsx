import { useMemo, useState, type ReactElement } from 'react';
import type { HistoryEntry } from '@/shared';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Folder, Retry } from '@/ui/components/Icons';
import { formatTargetLabel, summarizeSettings } from '@/ui/format/summary';
import { summaryStrings } from '@/ui/format/strings';
import { formatDateTime, toIsoString } from '@/ui/format/time';
import { useLocale, useNumberFormat, useStrings } from '@/ui/i18n/locale';
import { ConfirmInline } from '../components/ConfirmInline';
import { NoticeBar } from '../components/NoticeBar';
import { ViewHeader } from '../components/ViewHeader';
import { usePopupStore } from '../context';
import { historyStrings } from '../strings';

const STATUS: Record<HistoryEntry['status'], { key: 'statusDone' | 'statusPartial' | 'statusFailed'; tone: 'success' | 'warning' | 'danger' }> = {
  done: { key: 'statusDone', tone: 'success' },
  partial: { key: 'statusPartial', tone: 'warning' },
  failed: { key: 'statusFailed', tone: 'danger' },
};

function HistoryRow({ entry, onRerun }: { entry: HistoryEntry; onRerun: (id: string) => void }): ReactElement {
  const t = useStrings(historyStrings);
  const s = useStrings(summaryStrings);
  const fmt = useNumberFormat();
  const locale = useLocale();
  const timeZone = usePopupStore((state) => state.settings.timeZone);
  const showDownload = usePopupStore((state) => state.showDownload);
  const label = formatTargetLabel(entry.target);
  const status = STATUS[entry.status];
  const firstFile = entry.files[0];
  return (
    <li className="dce-history__row" data-status={entry.status}>
      <div className="dce-history__main">
        <div className="dce-history__title">
          <span className="dce-history__label" title={label}>
            {label}
          </span>
          <Badge tone={status.tone}>{t[status.key]}</Badge>
        </div>
        <div className="dce-history__meta">
          <time dateTime={toIsoString(entry.finishedAt)}>{formatDateTime(entry.finishedAt, locale, timeZone)}</time>
          <span aria-hidden="true">·</span>
          <span>{t.messages(entry.messageCount, fmt)}</span>
        </div>
        <div className="dce-history__summary">{summarizeSettings(entry.settings, s, fmt)}</div>
        {entry.error === null || entry.error === '' ? null : <div className="dce-history__error">{entry.error}</div>}
      </div>
      <div className="dce-history__actions">
        {firstFile === undefined ? null : (
          <Button variant="secondary" size="sm" icon={<Folder />} aria-label={t.openFolderFor(label)} onClick={() => void showDownload(firstFile.downloadId)}>
            {t.openFolder}
          </Button>
        )}
        <Button variant="secondary" size="sm" icon={<Retry />} aria-label={t.rerunFor(label)} onClick={() => onRerun(entry.id)}>
          {t.rerun}
        </Button>
      </div>
    </li>
  );
}

/**
 * The download history (docs/PLAN.md §2 #16): newest first, with the chat, when, how many messages and how it ended; [폴더 열기]
 * shows the first saved file (`downloads/show`), [다시 받기] downloads the chat again with the settings it was saved with
 * (`history/rerun`), [기록 지우기] (asks first) empties the list (`history/clear`).
 */
export function HistoryView({ onBack }: { onBack: () => void }): ReactElement {
  const t = useStrings(historyStrings);
  const history = usePopupStore((state) => state.history);
  const rerunHistory = usePopupStore((state) => state.rerunHistory);
  const clearHistory = usePopupStore((state) => state.clearHistory);
  const [confirming, setConfirming] = useState(false);
  const sorted = useMemo(() => [...history].sort((a, b) => b.finishedAt - a.finishedAt), [history]);

  const rerun = async (id: string): Promise<void> => {
    // The download shows its progress on the main screen.
    if (await rerunHistory(id)) onBack();
  };

  return (
    <div className="dce-view dce-view--sheet">
      <ViewHeader title={t.title} onBack={onBack} />
      <div className="dce-view__scroll">
        <div className="dce-pad dce-pad--tight">
          <NoticeBar />
        </div>
        {sorted.length === 0 ? (
          <p className="dce-empty dce-empty--plain">{t.empty}</p>
        ) : (
          <ul className="dce-history" aria-label={t.listLabel}>
            {sorted.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} onRerun={(id) => void rerun(id)} />
            ))}
          </ul>
        )}
      </div>
      <footer className="dce-footer dce-footer--end">
        {confirming ? (
          <ConfirmInline
            message={t.clearConfirm}
            confirmLabel={t.clearConfirmYes}
            cancelLabel={t.clearConfirmNo}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              void clearHistory();
            }}
          />
        ) : (
          <Button variant="secondary" disabled={sorted.length === 0} onClick={() => setConfirming(true)}>
            {t.clear}
          </Button>
        )}
      </footer>
    </div>
  );
}
