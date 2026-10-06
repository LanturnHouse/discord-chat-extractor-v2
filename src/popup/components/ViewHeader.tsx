import type { ReactElement, ReactNode } from 'react';
import { ArrowLeft } from '@/ui/components/Icons';
import { IconButton } from '@/ui/components/Button';
import { commonStrings } from '@/ui/i18n/common';
import { useStrings } from '@/ui/i18n/locale';

export interface ViewHeaderProps {
  title: string;
  /** A second line (the chat an editor belongs to). */
  subtitle?: string;
  onBack: () => void;
  /** More controls on the right. */
  actions?: ReactNode;
}

/** The bar of every screen but the main one: a back arrow, the title (it takes the focus when the screen opens) and the subtitle. */
export function ViewHeader({ title, subtitle, onBack, actions }: ViewHeaderProps): ReactElement {
  const c = useStrings(commonStrings);
  return (
    <header className="dce-viewheader">
      <IconButton label={c.back} onClick={onBack} data-focus-id="back">
        <ArrowLeft />
      </IconButton>
      <div className="dce-viewheader__text">
        <h1 className="dce-viewheader__title" tabIndex={-1} data-view-heading="">
          {title}
        </h1>
        {subtitle === undefined ? null : (
          <p className="dce-viewheader__subtitle" title={subtitle}>
            {subtitle}
          </p>
        )}
      </div>
      {actions}
    </header>
  );
}
