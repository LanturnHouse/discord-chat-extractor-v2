import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from 'react';
import type { Locale, StringDict, StringTable } from './core';

const LocaleContext = createContext<Locale>('ko');

/** Provides the language every `useStrings` / `useNumberFormat` below it uses. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }): ReactElement {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** The language in use. */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** Strings of one area in the current language. The returned object is stable for a given language. */
export function useStrings<S extends StringDict>(table: StringTable<S>): S {
  return table[useLocale()];
}

/** Formats a count for the current language (built once per language by `useNumberFormat`). */
export type NumberFormatter = (value: number) => string;

/** `Intl.NumberFormat` of the current language ("48,213"), built once per language. */
export function useNumberFormat(): NumberFormatter {
  const locale = useLocale();
  return useMemo(() => {
    const format = new Intl.NumberFormat(locale);
    return (value: number): string => format.format(value);
  }, [locale]);
}
