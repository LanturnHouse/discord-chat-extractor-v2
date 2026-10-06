import { useId, type ReactElement } from 'react';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The visible text, and the accessible name of the switch. */
  label: string;
  /** Smaller text under the label; announced as the switch's description. */
  description?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * An on/off switch. A real `<input type="checkbox" role="switch">` (Space toggles it, the label is clickable, the state is
 * announced) with a drawn track: the input is only visually hidden.
 */
export function Toggle({ checked, onChange, label, description, disabled = false, className }: ToggleProps): ReactElement {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  return (
    <label className={`dce-toggle${className === undefined ? '' : ` ${className}`}`} data-disabled={disabled ? '' : undefined}>
      <span className="dce-toggle__text">
        <span id={labelId} className="dce-toggle__label">
          {label}
        </span>
        {description === undefined ? null : (
          <span id={descriptionId} className="dce-toggle__description">
            {description}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="dce-toggle__input"
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        onChange={(event) => {
          if (!disabled) onChange(event.currentTarget.checked);
        }}
      />
      <span className="dce-toggle__track" aria-hidden="true">
        <span className="dce-toggle__thumb" />
      </span>
    </label>
  );
}
