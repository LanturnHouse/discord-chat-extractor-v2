import { useState, type ReactElement, type ReactNode } from 'react';
import { Button } from '@/ui/components/Button';
import { Info, SpinnerIcon, Warning } from '@/ui/components/Icons';
import { useStrings } from '@/ui/i18n/locale';
import { usePopupStore } from '../context';
import { popupStrings } from '../strings';

function Banner({ tone, icon, role, children, action }: { tone: 'info' | 'warning' | 'error'; icon: ReactNode; role: 'status' | 'alert'; children: ReactNode; action?: ReactNode }): ReactElement {
  return (
    <div className={`dce-banner dce-banner--${tone}`} role={role}>
      <span className="dce-banner__icon">{icon}</span>
      <div className="dce-banner__text">{children}</div>
      {action}
    </div>
  );
}

/**
 * What the popup says about the Discord side (docs/PLAN.md §7.2): no Discord tab and no account (with a button that opens
 * Discord), a tab that is open while the account is still being checked (or whose login expired), buttons that could not be
 * put on the page, and a background worker that does not answer. Nothing is shown before the first answer of `status/get`.
 */
export function Banners(): ReactElement | null {
  const t = useStrings(popupStrings);
  const statusLoaded = usePopupStore((state) => state.statusLoaded);
  const connectionLost = usePopupStore((state) => state.connectionLost);
  const account = usePopupStore((state) => state.account);
  const discordTabs = usePopupStore((state) => state.discordTabs);
  const health = usePopupStore((state) => state.health);
  const job = usePopupStore((state) => state.job);
  const openDiscord = usePopupStore((state) => state.openDiscord);
  const [opening, setOpening] = useState(false);

  const banners: ReactElement[] = [];
  if (connectionLost) {
    banners.push(
      <Banner key="connection" tone="error" role="alert" icon={<Warning />}>
        <span>{t.bannerConnection}</span>
      </Banner>,
    );
  }
  if (statusLoaded && account === null) {
    if (discordTabs === 0) {
      banners.push(
        <Banner
          key="no-discord"
          tone="info"
          role="status"
          icon={<Info />}
          action={
            <Button
              size="sm"
              disabled={opening}
              onClick={async () => {
                setOpening(true);
                try {
                  await openDiscord();
                } finally {
                  setOpening(false);
                }
              }}
            >
              {t.openDiscord}
            </Button>
          }
        >
          <span>{t.bannerNoDiscord}</span>
        </Banner>,
      );
    } else if (job?.items.some((item) => item.error?.kind === 'auth') === true) {
      banners.push(
        <Banner key="expired" tone="warning" role="alert" icon={<Warning />}>
          <span>{t.bannerExpired}</span>
        </Banner>,
      );
    } else {
      banners.push(
        <Banner key="checking" tone="info" role="status" icon={<SpinnerIcon />}>
          <strong>{t.bannerChecking}</strong>
          <span className="dce-banner__detail">{t.bannerCheckingHint}</span>
        </Banner>,
      );
    }
  }
  if (statusLoaded && discordTabs > 0 && health !== null && !health.ok) {
    banners.push(
      <Banner key="inject" tone="warning" role="alert" icon={<Warning />}>
        <span>{t.bannerInject}</span>
        {health.reason === null || health.reason === '' ? null : <span className="dce-banner__detail">{t.bannerInjectReason(health.reason)}</span>}
      </Banner>,
    );
  }
  return banners.length === 0 ? null : <div className="dce-banners">{banners}</div>;
}
