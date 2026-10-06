import type { ReactElement } from 'react';
import { summarizeSettings } from '@/ui/format/summary';
import { summaryStrings } from '@/ui/format/strings';
import { useNumberFormat, useStrings } from '@/ui/i18n/locale';
import type { GroupNodeModel, TreeRowModel } from '../tree/buildQueueTree';
import { GroupRow } from './GroupRow';
import { QueueRow } from './QueueRow';
import { chatRiskAnchor, groupRiskAnchor } from './RiskConfirm';

export interface QueueTreeProps {
  rows: readonly TreeRowModel[];
  /** A job is running: nothing can be started now. */
  jobActive: boolean;
  onToggle: (groupId: string) => void;
  /** ▶ of a chat or of a group: start these chats (`anchor` = where a safety question for them is shown: `groupRiskAnchor` / `chatRiskAnchor`). */
  onStart: (keys: string[], anchor: string) => void;
  /** ⚙ of a chat. */
  onEditItem: (key: string) => void;
  /** ⚙ of a server or category. */
  onEditGroup: (node: GroupNodeModel) => void;
  /** ✕ of a chat. */
  onRemoveItem: (key: string) => void;
  /** ✕ of a server or category (already confirmed). */
  onRemoveGroup: (node: GroupNodeModel) => void;
}

/** The rows of the queue tree: group lines with their nested lists, and the chats. A group's chats are only in the DOM while it is open. */
export function QueueTreeRows({ rows, ...handlers }: QueueTreeProps): ReactElement {
  const s = useStrings(summaryStrings);
  const fmt = useNumberFormat();
  const { jobActive, onToggle, onStart, onEditItem, onEditGroup, onRemoveItem, onRemoveGroup } = handlers;
  return (
    <>
      {rows.map((row) =>
        row.type === 'group' ? (
          <GroupRow
            key={`group:${row.id}`}
            node={row}
            jobActive={jobActive}
            onToggle={() => onToggle(row.id)}
            onStart={() => onStart(row.keys, groupRiskAnchor(row.id))}
            onEdit={() => onEditGroup(row)}
            onRemove={() => onRemoveGroup(row)}
          >
            {row.expanded ? <QueueTreeRows rows={row.children} {...handlers} /> : null}
          </GroupRow>
        ) : (
          <QueueRow
            key={row.key}
            row={row}
            summary={summarizeSettings(row.settings, s, fmt)}
            jobActive={jobActive}
            onStart={() => onStart([row.key], chatRiskAnchor(row.key))}
            onEdit={() => onEditItem(row.key)}
            onRemove={() => onRemoveItem(row.key)}
          />
        ),
      )}
    </>
  );
}
