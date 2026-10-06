import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { Badge } from '@/ui/components/Badge';
import { IconButton } from '@/ui/components/Button';
import { ChevronRight, Close, Folder, Gear, Play } from '@/ui/components/Icons';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { useNumberFormat, useStrings } from '@/ui/i18n/locale';
import { usePopupStore } from '../context';
import { popupStrings } from '../strings';
import type { GroupNodeModel } from '../tree/buildQueueTree';
import { ConfirmInline } from './ConfirmInline';
import { RiskConfirm, focusById, groupRiskAnchor } from './RiskConfirm';
import { ServerIcon } from './ServerIcon';
import { SettingsBadge } from './SettingsBadge';

export interface GroupRowProps {
  node: GroupNodeModel;
  /** A job is running: nothing can be started now. */
  jobActive: boolean;
  onToggle: () => void;
  /** ▶: download the chats of the group. */
  onStart: () => void;
  /** ⚙: the settings of the group. */
  onEdit: () => void;
  /** ✕ after the inline confirmation: take the chats of the group out of the list. */
  onRemove: () => void;
  /** The nested list of the chats below, while the group is open. */
  children?: ReactNode;
}

/**
 * A server or category line of the queue tree (docs/PLAN.md §7.2a): chevron, icon (the server's picture or a folder), name, the
 * number of chats ("전체 N개" when every viewable channel is queued), where the settings of the chats below come from, how many
 * of them have their own, how many did not finish (a collapsed group must not hide a failure), and ▶ ⚙ ✕. The whole line is one button that opens and closes the group (Enter / Space, `aria-expanded`);
 * the three actions are buttons of their own beside it. While a job runs the line shows the progress of the chats inside.
 */
export function GroupRow({ node, jobActive, onToggle, onStart, onEdit, onRemove, children }: GroupRowProps): ReactElement {
  const t = useStrings(popupStrings);
  const fmt = useNumberFormat();
  const [confirming, setConfirming] = useState(false);
  const riskOpen = usePopupStore((state) => state.riskPrompt !== null);
  const dismissRisk = usePopupStore((state) => state.dismissRisk);
  // Only one question is open at a time: a safety question for a download closes this one.
  useEffect(() => {
    if (riskOpen) setConfirming(false);
  }, [riskOpen]);
  const listId = useId();
  const chipId = useId();
  const metaId = useId();
  // Cancelling the confirmation puts the focus back on the ✕ that opened it (it is not lost to the page).
  const removeButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current = false;
    removeButton.current?.focus();
  }, [confirming]);
  const startBlocked = jobActive;
  const { progress } = node;
  const progressText = progress === null ? '' : t.groupProgressText(progress.finished, progress.total, fmt);

  return (
    <li className="dce-node" data-group-id={node.id} data-group-kind={node.kind}>
      <div className="dce-group" data-expanded={node.expanded ? '' : undefined} style={{ '--dce-depth': node.depth } as CSSProperties}>
        <div className="dce-group__head">
          <button
            type="button"
            className="dce-group__main"
            aria-expanded={node.expanded}
            aria-controls={node.expanded ? listId : undefined}
            aria-label={node.name}
            aria-describedby={`${chipId} ${metaId}`}
            data-focus-id={`toggle:${node.id}`}
            onClick={onToggle}
          >
            <span className="dce-group__chevron" aria-hidden="true">
              <ChevronRight />
            </span>
            <span className="dce-group__body">
              <span className="dce-group__title">
                {node.kind === 'guild' ? <ServerIcon url={node.iconUrl} name={node.name} /> : <Folder className="dce-row__kind" />}
                <span className="dce-group__name" title={node.name}>
                  {node.name}
                </span>
                <span className="dce-chip" id={chipId} title={node.complete ? t.groupCountAllTitle(node.count, fmt) : t.groupCountTitle(node.count, fmt)}>
                  {node.complete ? t.groupCountAll(node.count, fmt) : t.groupCount(node.count, fmt)}
                </span>
              </span>
              <span className="dce-group__meta" id={metaId}>
                {node.subtitle === null ? null : (
                  <span className="dce-group__subtitle">
                    {node.subtitle.names.join(', ')}
                    {node.subtitle.more ? ` ${t.subtitleMore}` : ''}
                  </span>
                )}
                <SettingsBadge source={node.settingsSource} />
                {node.overrideCount > 0 ? (
                  <Badge tone="brand" title={t.overrideChipTitle(node.overrideCount, fmt)}>
                    {t.overrideChip(node.overrideCount, fmt)}
                  </Badge>
                ) : null}
                {node.failedCount > 0 ? (
                  <Badge tone="danger" title={t.failedChipTitle(node.failedCount, fmt)}>
                    {t.failedChip(node.failedCount, fmt)}
                  </Badge>
                ) : null}
              </span>
            </span>
          </button>
          <div className="dce-row__actions">
            <IconButton
              tone="brand"
              label={t.startGroup(node.name)}
              title={startBlocked ? t.startBusyTitle : t.startGroup(node.name)}
              aria-disabled={startBlocked ? true : undefined}
              data-focus-id={`start-group:${node.id}`}
              onClick={() => {
                if (!startBlocked) onStart();
              }}
            >
              <Play />
            </IconButton>
            <IconButton label={t.editGroup(node.name)} data-focus-id={`edit-group:${node.id}`} onClick={onEdit}>
              <Gear />
            </IconButton>
            <IconButton
              ref={removeButton}
              tone="danger"
              label={t.removeGroup(node.name)}
              data-focus-id={`remove-group:${node.id}`}
              disabled={confirming}
              onClick={() => {
                dismissRisk();
                setConfirming(true);
              }}
            >
              <Close />
            </IconButton>
          </div>
        </div>
        {progress === null ? null : (
          <div className="dce-group__progress">
            <ProgressBar value={progress.ratio} label={t.groupProgressLabel(node.name)} valueText={progressText} tone="brand" />
            <div className="dce-row__status">
              <span>{progressText}</span>
            </div>
          </div>
        )}
        <RiskConfirm anchor={groupRiskAnchor(node.id)} restoreFocus={() => focusById(`start-group:${node.id}`)} />
        {confirming ? (
          <ConfirmInline
            message={t.removeGroupConfirm(node.count, fmt)}
            confirmLabel={t.removeGroupYes}
            cancelLabel={t.removeGroupNo}
            onCancel={() => {
              refocus.current = true;
              setConfirming(false);
            }}
            onConfirm={() => {
              setConfirming(false);
              onRemove();
            }}
          />
        ) : null}
      </div>
      {node.expanded ? (
        <ul className="dce-children" id={listId} aria-label={node.name} style={{ '--dce-depth': node.depth + 1 } as CSSProperties}>
          {children}
        </ul>
      ) : null}
    </li>
  );
}
