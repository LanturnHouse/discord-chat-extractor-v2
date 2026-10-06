import type { ReactElement } from 'react';
import type { SettingsSource } from '@/shared';
import { Badge } from '@/ui/components/Badge';
import { useStrings } from '@/ui/i18n/locale';
import { popupStrings } from '../strings';

/**
 * Where the settings of a chat, or of the chats below a group line, come from (docs/PLAN.md §7.2a): "공통 설정" / "서버 설정" /
 * "카테고리 설정", and "개별 설정" for a chat that has settings of its own (the one badge in the brand colour).
 */
export function SettingsBadge({ source }: { source: SettingsSource }): ReactElement {
  const t = useStrings(popupStrings);
  switch (source) {
    case 'item':
      return (
        <Badge tone="brand" title={t.ownBadgeTitle}>
          {t.ownBadge}
        </Badge>
      );
    case 'category':
      return (
        <Badge tone="info" title={t.categoryBadgeTitle}>
          {t.categoryBadge}
        </Badge>
      );
    case 'guild':
      return (
        <Badge tone="info" title={t.guildBadgeTitle}>
          {t.guildBadge}
        </Badge>
      );
    case 'common':
      return (
        <Badge tone="neutral" title={t.commonBadgeTitle}>
          {t.commonBadge}
        </Badge>
      );
  }
}
