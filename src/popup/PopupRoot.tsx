import { useEffect, useLayoutEffect, useMemo, type ReactElement } from 'react';
import { LocaleProvider } from '@/ui/i18n/locale';
import { resolveUiLocale } from '@/ui/i18n/core';
import type { Platform } from '@/ui/platform/types';
import { useTheme } from '@/ui/theme/useTheme';
import { PopupApp } from './PopupApp';
import { PopupProviders, usePlatform, usePopupStore } from './context';
import { createPopupStore, type PopupStoreOptions } from './store';

/** Applies the Discord theme and the app language to everything below. */
function Localized(): ReactElement {
  const platform = usePlatform();
  const language = usePopupStore((state) => state.settings.language);
  const theme = usePopupStore((state) => state.theme);
  const locale = resolveUiLocale(language, theme?.lang, platform.getUiLanguage());
  useTheme(theme);
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <LocaleProvider locale={locale}>
      <PopupApp />
    </LocaleProvider>
  );
}

export interface PopupRootProps extends PopupStoreOptions {
  platform: Platform;
}

/**
 * The whole popup: one store on one platform (the real extension, or the in-memory mock), started when it appears and stopped
 * when it goes away (storage listener and the 2 s `status/get` poll).
 */
export function PopupRoot({ platform, pollMs }: PopupRootProps): ReactElement {
  const store = useMemo(() => createPopupStore(platform, pollMs === undefined ? {} : { pollMs }), [platform, pollMs]);
  useEffect(() => store.getState().start(), [store]);
  return (
    <PopupProviders store={store} platform={platform}>
      <Localized />
    </PopupProviders>
  );
}
