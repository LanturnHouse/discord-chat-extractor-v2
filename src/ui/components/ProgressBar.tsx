import type { CSSProperties, ReactElement } from 'react';

export interface ProgressBarProps {
  /** 0..1, or null when the total is not known (an animated bar without a value). */
  value: number | null;
  /** Accessible name ("Sample Server > #general 진행률"). */
  label: string;
  /** Text read out with the value ("120 / 200"). */
  valueText?: string;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  className?: string;
}

/** A thin progress bar: `role="progressbar"` with its value in percent, or indeterminate (no value, sliding fill). */
export function ProgressBar({ value, label, valueText, tone = 'brand', className }: ProgressBarProps): ReactElement {
  const ratio = value === null || !Number.isFinite(value) ? null : Math.min(1, Math.max(0, value));
  const style: CSSProperties | undefined = ratio === null ? undefined : { width: `${Math.round(ratio * 1000) / 10}%` };
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
      aria-valuetext={valueText}
      className={`dce-progress dce-progress--${tone}${className === undefined ? '' : ` ${className}`}`}
      data-indeterminate={ratio === null ? '' : undefined}
    >
      <div className="dce-progress__fill" style={style} />
    </div>
  );
}
