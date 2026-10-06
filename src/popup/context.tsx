import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Platform } from '@/ui/platform/types';
import type { PopupActions, PopupState, PopupStore } from './store';

const StoreContext = createContext<PopupStore | null>(null);
const PlatformContext = createContext<Platform | null>(null);

export function PopupProviders({ store, platform, children }: { store: PopupStore; platform: Platform; children: ReactNode }): ReactElement {
  return (
    <PlatformContext.Provider value={platform}>
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    </PlatformContext.Provider>
  );
}

export function usePopupStoreApi(): PopupStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error('usePopupStore must be used inside <PopupProviders>');
  return store;
}

/** A slice of the popup state or one of its actions. Select stable references (a field, a function), never a freshly built object. */
export function usePopupStore<T>(selector: (state: PopupState & PopupActions) => T): T {
  return useStore(usePopupStoreApi(), selector);
}

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (platform === null) throw new Error('usePlatform must be used inside <PopupProviders>');
  return platform;
}
