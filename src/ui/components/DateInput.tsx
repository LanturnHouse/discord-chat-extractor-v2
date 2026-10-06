import { useId, useRef, type ReactElement } from 'react';
import { Close } from './Icons';

export interface DateInputProps {
  /** The input's value: "2026-10-06" or ''. */
  value: string;
  /** The user typed part of a date: the input's value is '' although it shows something. */
  partial: boolean;
  onChange: (value: string, partial: boolean) => void;
  /** The visible label ("시작일"). */
  label: string;
  /** Accessible name of the clear button ("시작일 지우기"). */
  clearLabel: string;
  invalid?: boolean;
  /** Ids of the elements that describe the input (an error message). */
  describedBy?: string;
  disabled?: boolean;
}

// An unbounded date input accepts 5 and 6 digit years, which an export cannot use; with `max` it stops at 4.
const MIN_DATE = '0001-01-01';
const MAX_DATE = '9999-12-31';

/** A labelled `<input type="date">` with a clear button (shown only while the field holds something). */
export function DateInput({ value, partial, onChange, label, clearLabel, invalid = false, describedBy, disabled = false }: DateInputProps): ReactElement {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // `onChange` only fires when the value changes; leaving the field is the other moment an unfinished date shows up.
  const report = (input: HTMLInputElement): void => onChange(input.value, input.validity.badInput);
  const empty = value === '' && !partial;
  return (
    <div className="dce-date">
      <label htmlFor={inputId} className="dce-date__label">
        {label}
      </label>
      <div className="dce-date__control">
        <input
          ref={inputRef}
          id={inputId}
          type="date"
          min={MIN_DATE}
          max={MAX_DATE}
          className="dce-date__input"
          value={value}
          disabled={disabled}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? describedBy : undefined}
          onChange={(event) => report(event.currentTarget)}
          onBlur={(event) => report(event.currentTarget)}
        />
        {empty ? (
          <span className="dce-date__slot" aria-hidden="true" />
        ) : (
          <button
            type="button"
            className="dce-date__clear"
            aria-label={clearLabel}
            title={clearLabel}
            disabled={disabled}
            onClick={() => {
              // A half-typed date has no value to reset through React: empty the control itself.
              if (inputRef.current !== null) inputRef.current.value = '';
              onChange('', false);
              inputRef.current?.focus();
            }}
          >
            <Close />
          </button>
        )}
      </div>
    </div>
  );
}
