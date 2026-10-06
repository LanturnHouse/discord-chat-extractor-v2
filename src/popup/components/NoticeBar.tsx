import type { ReactElement } from 'react';
import { IconButton } from '@/ui/components/Button';
import { Close, Warning } from '@/ui/components/Icons';
import { commonStrings } from '@/ui/i18n/common';
import { useStrings } from '@/ui/i18n/locale';
import { usePopupStore } from '../context';
import { noticeText } from '../errors';
import { popupStrings } from '../strings';

/** The inline error of the last action (docs/PLAN.md §7.2: `no-account`, `no-consent`, `busy`, `empty`... in the app language). */
export function NoticeBar(): ReactElement | null {
  const notice = usePopupStore((state) => state.notice);
  const dismiss = usePopupStore((state) => state.dismissNotice);
  const t = useStrings(popupStrings);
  const c = useStrings(commonStrings);
  if (notice === null) return null;
  return (
    <div className="dce-banner dce-banner--error" role="alert" key={notice.seq}>
      <Warning className="dce-banner__icon" />
      <div className="dce-banner__text">
        <span>{noticeText(notice.code, t)}</span>
        {notice.message === undefined || notice.message === '' ? null : <span className="dce-banner__detail">{t.errDetail(notice.message)}</span>}
      </div>
      <IconButton size="sm" label={c.dismiss} onClick={dismiss}>
        <Close />
      </IconButton>
    </div>
  );
}
