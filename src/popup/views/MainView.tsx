import { useEffect, useLayoutEffect, useMemo, useRef, type ReactElement, type RefObject } from 'react';
import { IconButton } from '@/ui/components/Button';
import { Download, Gear, History } from '@/ui/components/Icons';
import { Toggle } from '@/ui/components/Toggle';
import { useStrings } from '@/ui/i18n/locale';
import { Avatar } from '../components/Avatar';
import { Banners } from '../components/Banners';
import { FinishedStrip } from '../components/FinishedStrip';
import { Footer } from '../components/Footer';
import { NoticeBar } from '../components/NoticeBar';
import { JobOnlyRow } from '../components/QueueRow';
import { QueueTreeRows } from '../components/QueueTree';
import { usePopupStore } from '../context';
import type { Navigate } from '../navigation';
import { isJobActive } from '../store';
import { popupStrings } from '../strings';
import { buildQueueTree, type GroupNodeModel } from '../tree/buildQueueTree';

function MainHeader({ onNavigate }: { onNavigate: Navigate }): ReactElement {
  const t = useStrings(popupStrings);
  const account = usePopupStore((state) => state.account);
  const lastAccount = usePopupStore((state) => state.lastAccount);
  const shown = account ?? lastAccount;
  const name = shown === null ? t.noAccountName : shown.globalName?.trim() || shown.username;
  return (
    <header className="dce-header">
      <Avatar url={shown?.avatarUrl} name={name} size={32} />
      <div className="dce-header__who" title={account === null && shown !== null ? t.lastAccountTitle : undefined} data-stale={account === null && shown !== null ? '' : undefined}>
        <span className="dce-header__name">{name}</span>
        <span className="dce-header__user">{shown === null ? t.noAccountHint : `@${shown.username}`}</span>
      </div>
      <div className="dce-header__actions">
        <IconButton label={t.historyButton} data-focus-id="history" onClick={() => onNavigate({ name: 'history' }, { returnFocus: 'history' })}>
          <History />
        </IconButton>
        <IconButton label={t.settingsButton} data-focus-id="app-settings" onClick={() => onNavigate({ name: 'app' }, { returnFocus: 'app-settings' })}>
          <Gear />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * Which control gets the focus once the row (or group) that holds `removed` is gone: the ✕ of the next row in the list, else of the
 * previous one, else the list itself. The ✕ buttons are in document order, which is the order of the tree; the ones inside the
 * removed group go away with it and do not count.
 */
export function focusIdAfterRemove(removed: Element | null): string {
  if (removed === null) return 'list';
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-id^="remove"]')).filter((button) => !removed.contains(button));
  const next = buttons.find((button) => (removed.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const previous = buttons.filter((button) => (removed.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).at(-1);
  return (next ?? previous)?.dataset.focusId ?? 'list';
}

function QueueList({ onNavigate }: { onNavigate: Navigate }): ReactElement | null {
  const t = useStrings(popupStrings);
  const queue = usePopupStore((state) => state.queue);
  const groups = usePopupStore((state) => state.groups);
  const groupSettings = usePopupStore((state) => state.groupSettings);
  const expanded = usePopupStore((state) => state.expanded);
  const queueLoaded = usePopupStore((state) => state.queueLoaded);
  const common = usePopupStore((state) => state.settings.common);
  const job = usePopupStore((state) => state.job);
  const history = usePopupStore((state) => state.history);
  const requestStart = usePopupStore((state) => state.requestStart);
  const removeItem = usePopupStore((state) => state.removeItem);
  const removeMany = usePopupStore((state) => state.removeMany);
  const toggleGroup = usePopupStore((state) => state.toggleGroup);
  const active = isJobActive(job);

  const tree = useMemo(
    () => buildQueueTree({ items: queue, groups, groupSettings, common, expanded, job, history, fallbackNames: { guild: t.unknownServer, category: t.unknownCategory } }),
    [queue, groups, groupSettings, common, expanded, job, history, t],
  );

  // After an item is removed, the focus moves to the same place in the list instead of falling back to the page.
  const focusAfterRemove = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterRemove.current;
    if (id === null) return;
    focusAfterRemove.current = null;
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-id]')).find((element) => element.dataset.focusId === id);
    (target ?? document.querySelector<HTMLElement>('.dce-main__list'))?.focus();
  }, [queue]);

  const inQueue = new Set(queue.map((item) => item.key));
  const jobOnly = active ? job.items.filter((row) => !inQueue.has(row.key) && row.status !== 'done') : [];
  if (queue.length === 0 && jobOnly.length === 0) {
    if (!queueLoaded) return null;
    return (
      <div className="dce-empty">
        <Download className="dce-empty__icon" />
        <p>{t.emptyHint}</p>
      </div>
    );
  }

  /** `holder` is the `li` of the row or group that goes away. */
  const afterRemoval = async (holder: Element | null, remove: () => Promise<boolean>): Promise<void> => {
    focusAfterRemove.current = focusIdAfterRemove(holder);
    if (!(await remove())) focusAfterRemove.current = null; // refused: nothing moved
  };
  const holderOf = (attribute: 'key' | 'groupId', id: string): Element | null =>
    Array.from(document.querySelectorAll<HTMLElement>(attribute === 'key' ? 'li[data-key]' : 'li[data-group-id]')).find((element) => element.dataset[attribute] === id) ?? null;

  return (
    <ul className="dce-queue" aria-label={t.queueLabel}>
      <QueueTreeRows
        rows={tree.rows}
        jobActive={active}
        onToggle={toggleGroup}
        onStart={(keys, anchor) => void requestStart(keys, anchor)}
        onEditItem={(key) => onNavigate({ name: 'item', key }, { returnFocus: `edit:${key}` })}
        onEditGroup={(node: GroupNodeModel) => onNavigate({ name: 'group', kind: node.kind, guildId: node.guildId, groupId: node.id }, { returnFocus: `edit-group:${node.id}` })}
        onRemoveItem={(key) => void afterRemoval(holderOf('key', key), () => removeItem(key))}
        onRemoveGroup={(node) => void afterRemoval(holderOf('groupId', node.id), () => removeMany(node.keys))}
      />
      {jobOnly.map((row) => (
        <JobOnlyRow key={row.key} progress={row} />
      ))}
    </ul>
  );
}

/**
 * The main screen (docs/PLAN.md §7.2): who is logged in, what is wrong with the Discord side, the "show buttons" switch, the
 * download list (a scrolling area of its own) and the footer with the download and clear buttons or the progress of a running job.
 */
export function MainView({ onNavigate, scrollTop }: { onNavigate: Navigate; scrollTop: RefObject<number> }): ReactElement {
  const t = useStrings(popupStrings);
  const showButtons = usePopupStore((state) => state.settings.showButtons);
  const patchSettings = usePopupStore((state) => state.patchSettings);
  const dismissRisk = usePopupStore((state) => state.dismissRisk);
  const listRef = useRef<HTMLDivElement>(null);

  // A safety question for a download does not wait on a screen the person has left.
  useEffect(() => dismissRisk, [dismissRisk]);

  // Coming back from another screen: the list is where it was.
  useLayoutEffect(() => {
    if (listRef.current !== null) listRef.current.scrollTop = scrollTop.current;
  }, [scrollTop]);

  return (
    <div className="dce-view dce-view--main">
      <MainHeader onNavigate={onNavigate} />
      <div className="dce-main__top">
        <NoticeBar />
        <Banners />
        <Toggle checked={showButtons} onChange={(next) => void patchSettings({ showButtons: next })} label={t.showButtons} description={t.showButtonsHint} />
      </div>
      <div
        className="dce-main__list"
        ref={listRef}
        tabIndex={-1}
        onScroll={(event) => {
          scrollTop.current = event.currentTarget.scrollTop;
        }}
      >
        <QueueList onNavigate={onNavigate} />
      </div>
      <FinishedStrip />
      <Footer onNavigate={onNavigate} />
    </div>
  );
}
