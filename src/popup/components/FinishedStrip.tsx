import type { ReactElement } from 'react';
import { Button, IconButton } from '@/ui/components/Button';
import { Check, Close, Folder, Info, Warning } from '@/ui/components/Icons';
import { commonStrings } from '@/ui/i18n/common';
import { useNumberFormat, useStrings } from '@/ui/i18n/locale';
import { usePopupStore } from '../context';
import { popupStrings } from '../strings';

/**
 * A one-time summary of a download that ended while the popup was open ("2개 완료, 1개는 끝내지 못했어요") with a button that opens
 * the download folder. It is gone once dismissed, when another download starts, or when the popup is closed.
 */
export function FinishedStrip(): ReactElement | null {
  const t = useStrings(popupStrings);
  const c = useStrings(commonStrings);
  const fmt = useNumberFormat();
  const job = usePopupStore((state) => state.justFinished);
  const dismiss = usePopupStore((state) => state.dismissFinished);
  const showDownload = usePopupStore((state) => state.showDownload);
  if (job === null) return null;

  const done = job.items.filter((item) => item.status === 'done').length;
  const problems = job.items.filter((item) => item.status === 'partial' || item.status === 'failed' || item.status === 'cancelled').length;
  const cancelled = job.state === 'cancelled';
  const failed = job.state === 'failed';
  const tone = failed ? 'error' : cancelled || problems > 0 ? 'warning' : 'success';
  const text = failed ? t.finishedFailed : cancelled ? t.finishedCancelled : problems > 0 ? t.finishedWithProblems(done, problems, fmt) : t.finishedDone;
  return (
    <div className={`dce-banner dce-banner--${tone} dce-finished`} role="status">
      <span className="dce-banner__icon">{tone === 'success' ? <Check /> : tone === 'warning' ? <Info /> : <Warning />}</span>
      <div className="dce-banner__text">
        <span>{text}</span>
      </div>
      {done > 0 ? (
        <Button size="sm" variant="secondary" icon={<Folder />} onClick={() => void showDownload(null)}>
          {t.openFolder}
        </Button>
      ) : null}
      <IconButton size="sm" label={c.dismiss} onClick={dismiss}>
        <Close />
      </IconButton>
    </div>
  );
}
