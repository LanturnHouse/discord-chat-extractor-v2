import type { ReactElement } from 'react';
import { useNumberFormat, useStrings, type NumberFormatter } from '@/ui/i18n/locale';
import { usePopupStore } from '../context';
import { RISK_MAX_CHATS, type DownloadRisk, type RiskReason } from '../downloadRisk';
import { popupStrings } from '../strings';
import { ConfirmInline } from './ConfirmInline';

type PopupStrings = (typeof popupStrings)['en'];

/** Where the safety question is drawn: at the start button that opened it. Only one is open at a time (`riskPrompt` of the store). */
export const FOOTER_RISK_ANCHOR = 'footer';
export const groupRiskAnchor = (groupId: string): string => `group:${groupId}`;
export const chatRiskAnchor = (key: string): string => `chat:${key}`;

/** Puts the focus on the control with this `data-focus-id` (the ▶ that opened the question), if it is on screen. */
export function focusById(id: string): void {
  Array.from(document.querySelectorAll<HTMLElement>('[data-focus-id]'))
    .find((element) => element.dataset.focusId === id)
    ?.focus();
}

export function riskReasonText(reason: RiskReason, risk: Pick<DownloadRisk, 'messageEstimate'>, t: PopupStrings, fmt: NumberFormatter): string {
  switch (reason) {
    case 'many-chats':
      return t.riskManyChats(RISK_MAX_CHATS, fmt);
    case 'unbounded':
      return t.riskUnbounded;
    case 'many-messages':
      return t.riskManyMessages(risk.messageEstimate ?? 0, fmt);
    case 'threads':
      return t.riskThreads;
  }
}

export interface RiskConfirmProps {
  /** This start button's place: the question is drawn here only when it was opened by this button. */
  anchor: string;
  /** Gives the focus back to the start button when the question is closed by [취소] or Esc. */
  restoreFocus: () => void;
}

/**
 * The inline question before a big download: how many chats, why that is a risk for the Discord account, [계속 받기] (starts
 * what was asked for) and [취소] (nothing starts). Rendered next to every start button; shows itself only where `riskPrompt`
 * says. The focus moves to [계속 받기]; Esc and [취소] close it and give the focus back to the start button.
 */
export function RiskConfirm({ anchor, restoreFocus }: RiskConfirmProps): ReactElement | null {
  const t = useStrings(popupStrings);
  const fmt = useNumberFormat();
  const prompt = usePopupStore((state) => state.riskPrompt);
  const confirmRisk = usePopupStore((state) => state.confirmRisk);
  const dismissRisk = usePopupStore((state) => state.dismissRisk);
  if (prompt === null || prompt.anchor !== anchor) return null;
  return (
    <ConfirmInline
      message={t.riskMessage(prompt.risk.chats, fmt)}
      details={prompt.risk.reasons.map((reason) => riskReasonText(reason, prompt.risk, t, fmt))}
      confirmLabel={t.riskContinue}
      cancelLabel={t.riskCancel}
      tone="primary"
      initialFocus="confirm"
      onConfirm={() => {
        restoreFocus();
        void confirmRisk();
      }}
      onCancel={() => {
        dismissRisk();
        restoreFocus();
      }}
    />
  );
}
