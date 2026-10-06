import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useEscapeKey } from '@/ui/components/hooks';
import { SpinnerIcon } from '@/ui/components/Icons';
import { commonStrings } from '@/ui/i18n/common';
import { useStrings } from '@/ui/i18n/locale';
import { usePopupStore } from './context';
import { parentView, type Navigate, type View } from './navigation';
import { AppSettingsView } from './views/AppSettingsView';
import { CommonSettingsView } from './views/CommonSettingsView';
import { ConsentReviewView, ConsentView } from './views/ConsentView';
import { GroupSettingsView } from './views/GroupSettingsView';
import { HistoryView } from './views/HistoryView';
import { ItemEditView } from './views/ItemEditView';
import { MainView } from './views/MainView';

function findFocusTarget(id: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-focus-id]')).find((element) => element.dataset.focusId === id);
}

/**
 * Which screen is shown (docs/PLAN.md §7.2): nothing until the first read of storage (no flash of the consent screen), the
 * first-run notice until the user agreed, otherwise the main screen or the sub screen the user opened. Keyboard: Esc goes one
 * screen back; the focus moves to the title of a screen that opens and returns to the control that opened it.
 */
export function PopupApp(): ReactElement {
  const c = useStrings(commonStrings);
  const loaded = usePopupStore((state) => state.loaded);
  const consentAt = usePopupStore((state) => state.settings.consentAt);
  const dismissNotice = usePopupStore((state) => state.dismissNotice);
  const [view, setView] = useState<View>({ name: 'main' });
  const scrollTop = useRef(0);
  // The `data-focus-id` to focus after each step back (a stack: a screen opened from a sub screen has its own opener).
  const returnTargets = useRef<(string | null)[]>([]);
  const focusTarget = useRef<string | null>(null);

  const navigate = useCallback<Navigate>(
    (next, options) => {
      returnTargets.current.push(options?.returnFocus ?? null);
      focusTarget.current = null;
      dismissNotice();
      setView(next);
    },
    [dismissNotice],
  );
  const back = useCallback(() => {
    focusTarget.current = returnTargets.current.pop() ?? null;
    dismissNotice();
    setView((current) => parentView(current));
  }, [dismissNotice]);

  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target !== null) {
      findFocusTarget(target)?.focus();
      return;
    }
    if (view.name !== 'main') document.querySelector<HTMLElement>('[data-view-heading]')?.focus();
  }, [view]);

  useEscapeKey(back, loaded && consentAt !== null && view.name !== 'main');

  if (!loaded) {
    return (
      <div className="dce-popup dce-popup--loading" role="status">
        <SpinnerIcon />
        <span>{c.loading}</span>
      </div>
    );
  }
  if (consentAt === null) {
    return (
      <div className="dce-popup" data-view="consent">
        <ConsentView />
      </div>
    );
  }
  return (
    <div className="dce-popup" data-view={view.name}>
      {view.name === 'main' ? <MainView onNavigate={navigate} scrollTop={scrollTop} /> : null}
      {view.name === 'common' ? <CommonSettingsView onBack={back} /> : null}
      {view.name === 'item' ? <ItemEditView key={view.key} itemKey={view.key} onBack={back} /> : null}
      {view.name === 'group' ? <GroupSettingsView key={`${view.kind}:${view.groupId}`} kind={view.kind} groupId={view.groupId} onBack={back} /> : null}
      {view.name === 'app' ? (
        <AppSettingsView onBack={back} onShowConsent={() => navigate({ name: 'consent-review' }, { returnFocus: 'show-consent' })} />
      ) : null}
      {view.name === 'history' ? <HistoryView onBack={back} /> : null}
      {view.name === 'consent-review' ? <ConsentReviewView onBack={back} /> : null}
    </div>
  );
}
