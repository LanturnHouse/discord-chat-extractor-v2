import { useId, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { Check } from './Icons';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  /** Smaller text under the label (cards only); announced as the option's description. */
  description?: string;
}

export interface RadioGroupProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange: (value: T) => void;
  /** 'cards' = stacked cards with a description and a check, 'segmented' = a compact row of choices. */
  variant: 'cards' | 'segmented';
  className?: string;
}

/**
 * Radio group with a roving tab stop: Tab reaches the checked option, the arrow keys move the choice (and the focus) like
 * native radio buttons do, Home / End jump to the ends. Options are real buttons with `role="radio"`. Used for the format
 * cards and the segmented controls (HTML theme, count mode, language) of the settings panel.
 */
export function RadioGroup<T extends string>({ label, value, options, onChange, variant, className }: RadioGroupProps<T>): ReactElement {
  const idPrefix = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const choose = (index: number): void => {
    const option = options[index];
    if (option === undefined) return;
    onChange(option.value);
    buttons.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = options.findIndex((option) => option.value === value);
    const last = options.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = current >= last ? 0 : current + 1;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = current <= 0 ? last : current - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    choose(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`dce-radio dce-radio--${variant}${className === undefined ? '' : ` ${className}`}`}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const description = variant === 'cards' ? option.description : undefined;
        const descriptionId = description === undefined ? undefined : `${idPrefix}-${option.value}`;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-describedby={descriptionId}
            tabIndex={checked ? 0 : -1}
            className="dce-radio__option"
            onClick={() => choose(index)}
          >
            <span className="dce-radio__text">
              <span className="dce-radio__label">{option.label}</span>
              {description === undefined ? null : (
                <span id={descriptionId} className="dce-radio__description">
                  {description}
                </span>
              )}
            </span>
            {variant === 'cards' && checked ? <Check className="dce-radio__check" /> : null}
          </button>
        );
      })}
    </div>
  );
}
