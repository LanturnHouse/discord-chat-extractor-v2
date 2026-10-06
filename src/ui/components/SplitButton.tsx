import type { ReactElement, ReactNode, Ref } from 'react';
import { DownloadCaret } from './Icons';

export interface SplitButtonProps {
  /** The main segment's text ("전체 다운로드"). */
  label: string;
  /** A small tag after the text (the format: "HTML"). */
  chip?: string;
  icon?: ReactNode;
  onMain: () => void;
  /** Accessible name of the caret segment ("공통 설정 열기"). */
  caretLabel: string;
  onCaret: () => void;
  /** The main segment cannot be used now: it is `aria-disabled` (still focusable, so its `mainTitle` can explain why) and ignores clicks. */
  mainDisabled?: boolean;
  mainTitle?: string;
  mainRef?: Ref<HTMLButtonElement>;
  caretRef?: Ref<HTMLButtonElement>;
  /** Written to `data-focus-id` of the caret, so the screen it opens can give the focus back to it. */
  caretFocusId?: string;
}

/**
 * v1's split DOWNLOAD button: the main segment does the action right away, the caret opens the options (the popup shows them
 * as a view of their own, so the caret carries no `aria-haspopup`). Two real buttons in one rounded pill. Only the main
 * segment is ever disabled: the options stay reachable while there is nothing to download.
 */
export function SplitButton({
  label,
  chip,
  icon,
  onMain,
  caretLabel,
  onCaret,
  mainDisabled = false,
  mainTitle,
  mainRef,
  caretRef,
  caretFocusId,
}: SplitButtonProps): ReactElement {
  return (
    <div className="dce-split" data-unavailable={mainDisabled ? '' : undefined}>
      <button
        ref={mainRef}
        type="button"
        className="dce-split__main"
        aria-disabled={mainDisabled ? true : undefined}
        title={mainTitle}
        onClick={() => {
          if (!mainDisabled) onMain();
        }}
      >
        {icon === undefined ? null : <span className="dce-split__icon">{icon}</span>}
        <span className="dce-split__label">{label}</span>
        {/* The space keeps the accessible name "Download all HTML" (inside a flex container it is not rendered). */}
        {chip === undefined ? null : (
          <>
            {' '}
            <span className="dce-split__chip">{chip}</span>
          </>
        )}
      </button>
      <button
        ref={caretRef}
        type="button"
        className="dce-split__caret"
        aria-label={caretLabel}
        title={caretLabel}
        data-focus-id={caretFocusId}
        onClick={onCaret}
      >
        <DownloadCaret />
      </button>
    </div>
  );
}
