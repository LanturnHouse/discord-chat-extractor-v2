import type { CSSProperties, ReactElement } from 'react';
import type { ChatKind, ItemProgress, ItemStatus, QueueItem } from '@/shared';
import { Button, IconButton } from '@/ui/components/Button';
import { ChatBubble, Close, Folder, Forum, Gear, Hash, Play, Thread, Warning } from '@/ui/components/Icons';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { safeImageUrl } from '@/ui/format/summary';
import { useNumberFormat, useStrings } from '@/ui/i18n/locale';
import { errorKindText } from '../errors';
import { failedStatusOf, isFailedStatus, progressRatio, type FailedStatus } from '../progress';
import { popupStrings } from '../strings';
import type { ChannelRowModel } from '../tree/buildQueueTree';
import { RiskConfirm, chatRiskAnchor, focusById } from './RiskConfirm';
import { ServerIcon } from './ServerIcon';
import { SettingsBadge } from './SettingsBadge';

type PopupStrings = (typeof popupStrings)['en'];

export interface QueueRowProps {
  /** The chat as the queue tree describes it: its place in the tree, its label, the settings it runs with and where they come from. */
  row: ChannelRowModel;
  /** The one-line summary of the EFFECTIVE settings. */
  summary: string;
  /** A job is running: nothing can be started now. */
  jobActive: boolean;
  onStart: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

const KIND_ICONS: Record<ChatKind, (props: { className?: string }) => ReactElement> = {
  'guild-channel': Hash,
  thread: Thread,
  forum: Forum,
  dm: ChatBubble,
  'group-dm': ChatBubble,
};

/** The small picture in front of a label: the avatar of a DM when the content script knew it, else a glyph for the kind of chat. */
export function KindIcon({ item }: { item: Pick<QueueItem, 'target'> }): ReactElement {
  const avatar = safeImageUrl(item.target.iconUrl);
  if (avatar !== null) return <img className="dce-row__avatar" src={avatar} alt="" width={20} height={20} referrerPolicy="no-referrer" />;
  const Icon = KIND_ICONS[item.target.kind];
  return <Icon className="dce-row__kind" />;
}

/** In front of a one-line row: the icon of the server or the folder of the category it stands for; otherwise the kind of chat. */
function RowLead({ row }: { row: ChannelRowModel }): ReactElement {
  const lead = row.path[0];
  if (lead === undefined) return <KindIcon item={row.item} />;
  return lead.kind === 'guild' ? <ServerIcon url={lead.iconUrl} name={lead.name} /> : <Folder className="dce-row__kind" />;
}

const PHASE_KEYS = {
  resolving: 'phaseResolving',
  messages: 'phaseMessages',
  threads: 'phaseThreads',
  attachments: 'phaseAttachments',
  writing: 'phaseWriting',
  saving: 'phaseSaving',
} as const;

const STATUS_KEYS: Record<ItemStatus, 'statusWaiting' | 'statusRunning' | 'statusPaused' | 'statusDone' | 'statusPartial' | 'statusFailed' | 'statusCancelled'> = {
  waiting: 'statusWaiting',
  running: 'statusRunning',
  paused: 'statusPaused',
  done: 'statusDone',
  partial: 'statusPartial',
  failed: 'statusFailed',
  cancelled: 'statusCancelled',
};

/** "메시지 가져오는 중" for a running item (its phase), the status word for everything else. */
export function statusLabel(progress: Pick<ItemProgress, 'status' | 'phase'>, t: PopupStrings): string {
  if (progress.status === 'running' && progress.phase !== null) return t[PHASE_KEYS[progress.phase]];
  return t[STATUS_KEYS[progress.status]];
}

export { progressRatio };

const FAILURE_FALLBACKS = { partial: 'failurePartial', failed: 'failureFailed', cancelled: 'failureCancelled' } as const;

/**
 * Why an item is not in the "waiting / running" state: what the job's row says about it, or - when the item is not part of the
 * running job - what the last attempt left on the item itself (docs/PLAN.md §6.7: failed, partial and cancelled items stay in
 * the list). An item that is part of the running job shows its progress instead of an old failure. Whether there is a failure
 * at all is `failedStatusOf` (the group lines count with the same rule).
 */
export function failureOf(item: QueueItem, progress: ItemProgress | undefined, jobActive: boolean, t: PopupStrings): { status: FailedStatus; message: string } | null {
  const status = failedStatusOf(item, progress, jobActive);
  if (status === null) return null;
  if (progress !== undefined && isFailedStatus(progress.status)) {
    const message = progress.error?.message.trim() || (progress.error === null ? '' : errorKindText(progress.error.kind, t)) || item.lastResult?.message.trim() || t[FAILURE_FALLBACKS[status]];
    return { status, message };
  }
  return { status, message: item.lastResult?.message.trim() || t[FAILURE_FALLBACKS[status]] };
}

/**
 * One chat of the download list: label, summary of its effective settings, which kind of settings, the actions, progress or
 * failure. Below a server or category it is indented (`--dce-depth`); a one-line row starts with the server or category it
 * stands for ("서버 › #채널"). The names of its buttons carry the full label ("서버 > #채널"), so they stay unambiguous in a tree.
 */
export function QueueRow({ row, summary, jobActive, onStart, onEdit, onRemove }: QueueRowProps): ReactElement {
  const t = useStrings(popupStrings);
  const fmt = useNumberFormat();
  const { item, progress } = row;
  const label = row.fullLabel;
  const failure = failureOf(item, progress, jobActive, t);
  const inProgress = jobActive && progress !== undefined && failure === null && progress.status !== 'done';
  const startBlocked = jobActive;

  return (
    <li className="dce-row" data-key={item.key} data-status={progress?.status} data-depth={row.depth} data-compressed={row.path.length > 0 ? row.path[0].kind : undefined} style={{ '--dce-depth': row.depth } as CSSProperties}>
      <div className="dce-row__main">
        <div className="dce-row__title">
          <RowLead row={row} />
          <span className="dce-row__label" title={row.tooltip}>
            {row.path.map((part, index) => (
              <span key={`${part.kind}:${index}`} className="dce-row__crumb">
                <span className="dce-row__crumb-name">{part.name}</span>
                <span className="dce-row__crumb-sep"> › </span>
              </span>
            ))}
            <span className="dce-row__name">{row.name}</span>
          </span>
        </div>
        <div className="dce-row__meta">
          <span className="dce-row__summary">{summary}</span>
          <SettingsBadge source={row.source} />
        </div>
        {inProgress ? (
          <div className="dce-row__progress">
            {progress.status === 'running' || progress.status === 'paused' ? (
              <ProgressBar
                value={progressRatio(progress)}
                label={t.itemProgress(label)}
                valueText={t.progressCount(progress.fetched, progress.expected, fmt)}
                tone={progress.status === 'paused' ? 'warning' : 'brand'}
              />
            ) : null}
            <div className="dce-row__status">
              <span>{statusLabel(progress, t)}</span>
              {progress.status === 'running' || progress.status === 'paused' ? <span className="dce-row__count">{t.progressCount(progress.fetched, progress.expected, fmt)}</span> : null}
            </div>
          </div>
        ) : null}
        {failure === null ? null : (
          <div className="dce-row__failure" data-failure={failure.status}>
            <Warning className="dce-row__failure-icon" />
            <span className="dce-row__failure-text">
              <strong>{t[STATUS_KEYS[failure.status]]}</strong> · {failure.message}
            </span>
            <Button
              variant="link"
              size="sm"
              aria-label={t.retryItem(label)}
              aria-disabled={startBlocked ? true : undefined}
              title={startBlocked ? t.startBusyTitle : undefined}
              onClick={() => {
                if (!startBlocked) onStart();
              }}
            >
              {t.retry}
            </Button>
          </div>
        )}
        <RiskConfirm anchor={chatRiskAnchor(item.key)} restoreFocus={() => focusById(`start:${item.key}`)} />
      </div>
      <div className="dce-row__actions">
        <IconButton
          tone="brand"
          label={t.startItem(label)}
          title={startBlocked ? t.startBusyTitle : t.startItem(label)}
          aria-disabled={startBlocked ? true : undefined}
          data-focus-id={`start:${item.key}`}
          onClick={() => {
            if (!startBlocked) onStart();
          }}
        >
          <Play />
        </IconButton>
        <IconButton label={t.editItem(label)} data-focus-id={`edit:${item.key}`} onClick={onEdit}>
          <Gear />
        </IconButton>
        <IconButton tone="danger" label={t.removeItem(label)} data-focus-id={`remove:${item.key}`} onClick={onRemove}>
          <Close />
        </IconButton>
      </div>
    </li>
  );
}

/** A chat of a running job that is not in the list (a download started again from the history): progress only, no actions. */
export function JobOnlyRow({ progress }: { progress: ItemProgress }): ReactElement {
  const t = useStrings(popupStrings);
  const fmt = useNumberFormat();
  const running = progress.status === 'running' || progress.status === 'paused';
  return (
    <li className="dce-row dce-row--job" data-key={progress.key} data-status={progress.status}>
      <div className="dce-row__main">
        <div className="dce-row__title">
          <span className="dce-row__label" title={progress.label}>
            {progress.label}
          </span>
        </div>
        <div className="dce-row__progress">
          {running ? (
            <ProgressBar
              value={progressRatio(progress)}
              label={t.itemProgress(progress.label)}
              valueText={t.progressCount(progress.fetched, progress.expected, fmt)}
              tone={progress.status === 'paused' ? 'warning' : 'brand'}
            />
          ) : null}
          <div className="dce-row__status">
            <span>{statusLabel(progress, t)}</span>
            {running ? <span className="dce-row__count">{t.progressCount(progress.fetched, progress.expected, fmt)}</span> : null}
          </div>
        </div>
      </div>
    </li>
  );
}
