import { useId, type ReactElement } from 'react';
import { Button } from '@/ui/components/Button';

export interface ConfirmInlineProps {
  /** The question ("목록을 모두 비울까요?"). */
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** A list of reasons under the question (the safety warning before a big download). */
  details?: readonly string[];
  /** The confirm button: 'danger' (default, red: it destroys something) or 'primary' (brand: it only goes ahead). */
  tone?: 'danger' | 'primary';
  /** Which button has the focus when the question opens. Default 'cancel', the safe choice. */
  initialFocus?: 'confirm' | 'cancel';
}

/**
 * An in-page confirmation (never `window.confirm`: it would steal the popup's focus and close it on some platforms). By default
 * it is for a destructive action: the focus starts on the safe choice, Esc cancels.
 */
export function ConfirmInline({ message, confirmLabel, cancelLabel, onConfirm, onCancel, details, tone = 'danger', initialFocus = 'cancel' }: ConfirmInlineProps): ReactElement {
  const detailsId = useId();
  const hasDetails = details !== undefined && details.length > 0;
  return (
    <div
      className={hasDetails ? 'dce-confirm dce-confirm--detailed' : 'dce-confirm'}
      role="group"
      aria-label={message}
      aria-describedby={hasDetails ? detailsId : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Only this confirmation closes: the screen behind it must not also react to the same key.
        event.preventDefault();
        onCancel();
      }}
    >
      <span className="dce-confirm__text">{message}</span>
      {hasDetails ? (
        <ul className="dce-confirm__details" id={detailsId}>
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <Button variant={tone} size="sm" autoFocus={initialFocus === 'confirm'} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button variant="secondary" size="sm" autoFocus={initialFocus === 'cancel'} onClick={onCancel}>
        {cancelLabel}
      </Button>
    </div>
  );
}
