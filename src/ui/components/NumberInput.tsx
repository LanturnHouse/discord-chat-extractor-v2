import type { ReactElement, Ref } from 'react';

export interface NumberInputProps {
  /** What the user typed, as text: the owner validates it (see `settings/fields.ts`), so a half-typed or wrong value is shown as is. */
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  /** Accessible name (the input has no visible label of its own). */
  label: string;
  invalid?: boolean;
  /** Ids of the elements that describe the input (a hint or an error message). */
  describedBy?: string;
  disabled?: boolean;
  /** A unit after the input ("개"); decorative. */
  unit?: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

const INTEGER = /^\d+$/;

/**
 * A whole-number field. A text input with a numeric keyboard (`type="number"` lets "1e3", "-" and mouse-wheel changes through)
 * that behaves as a spinbutton: ArrowUp / ArrowDown step by 1 (Shift: 10) inside `min`..`max`.
 */
export function NumberInput({ value, onChange, min, max, label, invalid = false, describedBy, disabled = false, unit, inputRef, className }: NumberInputProps): ReactElement {
  const text = value.trim();
  const parsed = INTEGER.test(text) ? Number(text) : null;
  const inRange = parsed !== null && parsed >= min && parsed <= max;

  const step = (direction: 1 | -1, size: number): void => {
    const base = parsed === null ? null : Math.min(max, Math.max(min, parsed));
    const next = base === null ? min : Math.min(max, Math.max(min, base + direction * size));
    onChange(String(next));
  };

  return (
    <span className={`dce-number${className === undefined ? '' : ` ${className}`}`}>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        role="spinbutton"
        autoComplete="off"
        spellCheck={false}
        className="dce-number__input"
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={inRange ? parsed : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          step(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey ? 10 : 1);
        }}
      />
      {unit === undefined ? null : (
        <span className="dce-number__unit" aria-hidden="true">
          {unit}
        </span>
      )}
    </span>
  );
}
