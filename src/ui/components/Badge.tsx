import type { ReactElement, ReactNode } from 'react';

export interface BadgeProps {
  tone?: 'neutral' | 'brand' | 'info' | 'success' | 'warning' | 'danger';
  children: ReactNode;
  title?: string;
}

/** A small pill ("공통 설정" / "서버 설정" / "개별 설정", the status of a history entry). */
export function Badge({ tone = 'neutral', children, title }: BadgeProps): ReactElement {
  return (
    <span className={`dce-badge dce-badge--${tone}`} title={title}>
      {children}
    </span>
  );
}
