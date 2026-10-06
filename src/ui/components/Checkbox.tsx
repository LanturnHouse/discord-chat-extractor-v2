import { useId, type ReactElement } from 'react';
import { Check } from './Icons';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The visible text, and the accessible name of the box. */
  label: string;
  /** Smaller text under the label; announced as the box's description. */
  description?: string;
  disabled?: boolean;
  className?: string;
}

/** Discord-style rounded checkbox with a label. A real `<input type="checkbox">`: the box is drawn next to the visually hidden input. */
export function Checkbox({ checked, onChange, label, description, disabled = false, className }: CheckboxProps): ReactElement {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  return (
    <label className={`dce-check${className === undefined ? '' : ` ${className}`}`} data-disabled={disabled ? '' : undefined}>
      <input
        type="checkbox"
        className="dce-check__input"
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        onChange={(event) => {
          if (!disabled) onChange(event.currentTarget.checked);
        }}
      />
      <span className="dce-check__box" aria-hidden="true">
        <Check />
      </span>
      <span className="dce-check__text">
        <span id={labelId} className="dce-check__label">
          {label}
        </span>
        {description === undefined ? null : (
          <span id={descriptionId} className="dce-check__description">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
