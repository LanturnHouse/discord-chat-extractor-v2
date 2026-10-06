import type { ButtonHTMLAttributes, ReactElement, ReactNode, Ref } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = brand, secondary = grey, danger = red, ghost = text on hover background, link = text only. Default 'primary'. */
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** An icon in front of the text. */
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** Discord-style text button. `type` defaults to "button" so it never submits a surrounding form by accident. */
export function Button({ variant = 'primary', size = 'md', type = 'button', className, icon, children, ...rest }: ButtonProps): ReactElement {
  const classes = `dce-button dce-button--${variant} dce-button--${size}${className === undefined ? '' : ` ${className}`}`;
  return (
    <button type={type} className={classes} {...rest}>
      {icon === undefined ? null : <span className="dce-button__icon">{icon}</span>}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Required: the accessible name and the tooltip (the button has no visible text). */
  label: string;
  /** The icon. */
  children: ReactNode;
  size?: 'md' | 'sm';
  /** 'danger' tints the hover state red (remove actions), 'brand' colours the icon (the primary action of a row). */
  tone?: 'default' | 'danger' | 'brand';
  ref?: Ref<HTMLButtonElement>;
}

/** A square icon-only button (the row actions, the header icons). */
export function IconButton({ label, children, size = 'md', tone = 'default', type = 'button', className, title, ...rest }: IconButtonProps): ReactElement {
  const classes = `dce-icon-button dce-icon-button--${size} dce-icon-button--${tone}${className === undefined ? '' : ` ${className}`}`;
  return (
    <button type={type} className={classes} aria-label={label} title={title ?? label} {...rest}>
      {children}
    </button>
  );
}
