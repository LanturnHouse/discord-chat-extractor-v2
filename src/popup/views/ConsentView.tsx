import { useState, type ReactElement } from 'react';
import { Button } from '@/ui/components/Button';
import { Folder, ChatBubble, Info, Warning } from '@/ui/components/Icons';
import { commonStrings } from '@/ui/i18n/common';
import { useLocale, useStrings } from '@/ui/i18n/locale';
import { formatDateTime } from '@/ui/format/time';
import { NoticeBar } from '../components/NoticeBar';
import { ViewHeader } from '../components/ViewHeader';
import { usePopupStore } from '../context';
import { consentStrings } from '../strings';

/** The four points of the notice (docs/PLAN.md §2 #11): Discord's terms and the account risk, own chats only, data stays local, slow requests. */
function ConsentNotice(): ReactElement {
  const t = useStrings(consentStrings);
  const points = [
    { icon: <Warning />, title: t.tosTitle, body: t.tosBody, tone: 'warning' },
    { icon: <ChatBubble />, title: t.ownTitle, body: t.ownBody, tone: 'info' },
    { icon: <Folder />, title: t.localTitle, body: t.localBody, tone: 'info' },
    { icon: <Info />, title: t.rateTitle, body: t.rateBody, tone: 'info' },
  ] as const;
  return (
    <ul className="dce-consent__points">
      {points.map((point) => (
        <li key={point.title} className="dce-consent__point" data-tone={point.tone}>
          <span className="dce-consent__icon">{point.icon}</span>
          <div>
            <h2 className="dce-consent__point-title">{point.title}</h2>
            <p className="dce-consent__point-body">{point.body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * First run (docs/PLAN.md §7.2): the Discord terms / account risk notice with [동의하고 시작]. Until the user agrees
 * (`settings.consentAt` is null) nothing else is shown, so nothing can be downloaded. Agreeing is not optimistic: the screen
 * only goes away once the background worker has stored the consent.
 */
export function ConsentView(): ReactElement {
  const t = useStrings(consentStrings);
  const patchSettings = usePopupStore((state) => state.patchSettings);
  const [busy, setBusy] = useState(false);
  const accept = async (): Promise<void> => {
    setBusy(true);
    try {
      await patchSettings({ consentAt: Date.now() }, { optimistic: false });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dce-view dce-view--consent">
      <div className="dce-view__scroll dce-pad">
        <header className="dce-consent__header">
          <h1 className="dce-consent__title" data-view-heading="" tabIndex={-1}>
            {t.title}
          </h1>
          <p className="dce-consent__intro">{t.intro}</p>
        </header>
        <NoticeBar />
        <ConsentNotice />
      </div>
      <footer className="dce-footer">
        <Button disabled={busy} onClick={() => void accept()}>
          {t.accept}
        </Button>
        <p className="dce-footer__note">{t.acceptNote}</p>
      </footer>
    </div>
  );
}

/** The same notice again (app settings -> "약관·위험 안내 다시 보기"): read-only, with the time the user agreed. */
export function ConsentReviewView({ onBack }: { onBack: () => void }): ReactElement {
  const t = useStrings(consentStrings);
  const c = useStrings(commonStrings);
  const locale = useLocale();
  const consentAt = usePopupStore((state) => state.settings.consentAt);
  const timeZone = usePopupStore((state) => state.settings.timeZone);
  return (
    <div className="dce-view dce-view--consent">
      <ViewHeader title={t.reviewTitle} onBack={onBack} />
      <div className="dce-view__scroll dce-pad">
        <ConsentNotice />
        {consentAt === null ? null : <p className="dce-consent__when">{t.consentedAt(formatDateTime(consentAt, locale, timeZone))}</p>}
      </div>
      <footer className="dce-footer">
        <Button variant="secondary" onClick={onBack}>
          {c.close}
        </Button>
      </footer>
    </div>
  );
}
