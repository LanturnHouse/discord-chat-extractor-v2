import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { JobState } from '@/shared';
import { Button } from '@/ui/components/Button';
import { Download } from '@/ui/components/Icons';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { SplitButton } from '@/ui/components/SplitButton';
import { FORMAT_CHIPS } from '@/ui/format/summary';
import { useNumberFormat, useStrings } from '@/ui/i18n/locale';
import { usePopupStore } from '../context';
import type { Navigate } from '../navigation';
import { overallProgress } from '../progress';
import { isJobActive } from '../store';
import { popupStrings } from '../strings';
import { ConfirmInline } from './ConfirmInline';
import { FOOTER_RISK_ANCHOR, RiskConfirm } from './RiskConfirm';

export { overallProgress };

function RunningFooter({ job }: { job: JobState }): ReactElement {
  const t = useStrings(popupStrings);
  const fmt = useNumberFormat();
  const cancelJob = usePopupStore((state) => state.cancelJob);
  const cancelling = usePopupStore((state) => state.cancelling);
  const { finished, total, ratio } = overallProgress(job);
  const percent = Math.round((ratio ?? 0) * 100);
  const text = t.overallText(finished, total, percent, fmt);
  return (
    <footer className="dce-footer dce-footer--running">
      <div className="dce-overall">
        <div className="dce-overall__text">
          <span>{t.overallProgress}</span>
          <span className="dce-overall__value">{text}</span>
        </div>
        <ProgressBar value={ratio} label={t.overallProgress} valueText={text} tone={job.state === 'paused' ? 'warning' : 'brand'} />
        {job.state === 'paused' ? <p className="dce-overall__note">{t.pausedRateLimit}</p> : null}
      </div>
      <Button variant="secondary" disabled={cancelling} onClick={() => void cancelJob()}>
        {cancelling ? t.cancelling : t.cancel}
      </Button>
    </footer>
  );
}

/**
 * The bottom of the main screen. Idle: v1's split button "⤓ 전체 다운로드 [HTML] ▾" (the main part starts every item, the caret
 * opens the common settings) and [목록 비우기] with an inline confirmation. While a job runs: the overall progress and [취소].
 */
export function Footer({ onNavigate }: { onNavigate: Navigate }): ReactElement {
  const t = useStrings(popupStrings);
  const job = usePopupStore((state) => state.job);
  const queueSize = usePopupStore((state) => state.queue.length);
  const format = usePopupStore((state) => state.settings.common.format);
  const requestStart = usePopupStore((state) => state.requestStart);
  const dismissRisk = usePopupStore((state) => state.dismissRisk);
  const riskOpen = usePopupStore((state) => state.riskPrompt !== null);
  const clearQueue = usePopupStore((state) => state.clearQueue);
  const [confirming, setConfirming] = useState(false);
  const mainButton = useRef<HTMLButtonElement>(null);
  // Only one question is open at a time: a safety question for a download closes this one.
  useEffect(() => {
    if (riskOpen) setConfirming(false);
  }, [riskOpen]);

  if (isJobActive(job)) return <RunningFooter job={job} />;
  const empty = queueSize === 0;
  return (
    <footer className="dce-footer">
      {confirming ? (
        <ConfirmInline
          message={t.clearConfirm}
          confirmLabel={t.clearConfirmYes}
          cancelLabel={t.clearConfirmNo}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void clearQueue();
          }}
        />
      ) : null}
      <RiskConfirm anchor={FOOTER_RISK_ANCHOR} restoreFocus={() => mainButton.current?.focus()} />
      <div className="dce-footer__row">
        <SplitButton
          label={t.downloadAll}
          chip={FORMAT_CHIPS[format]}
          icon={<Download />}
          onMain={() => void requestStart('all', FOOTER_RISK_ANCHOR)}
          mainRef={mainButton}
          mainDisabled={empty}
          mainTitle={empty ? t.emptyDownloadTitle : undefined}
          caretLabel={t.openCommonSettings}
          caretFocusId="common-settings"
          onCaret={() => onNavigate({ name: 'common' }, { returnFocus: 'common-settings' })}
        />
        <Button
          variant="secondary"
          disabled={empty || confirming}
          onClick={() => {
            dismissRisk();
            setConfirming(true);
          }}
        >
          {t.clearList}
        </Button>
      </div>
    </footer>
  );
}
