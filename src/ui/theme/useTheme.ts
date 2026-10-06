import { useLayoutEffect } from 'react';
import type { ThemeTokens } from '@/shared';
import { applyTheme } from './applyTheme';

/** Keeps `<html>` in sync with the stored Discord theme (null = the built-in dark palette). */
export function useTheme(tokens: ThemeTokens | null): void {
  useLayoutEffect(() => {
    applyTheme(tokens);
  }, [tokens]);
}
