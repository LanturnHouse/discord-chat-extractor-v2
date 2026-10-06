/**
 * Tiny type-safe i18n core (the approach of v1's `defineStrings`): no library, no runtime parsing, no React. Pure, so it can
 * be used by stores, tests and the build alike. React components read their strings with `useStrings` (./locale.tsx).
 */

export type Locale = 'ko' | 'en';
export const LOCALES: readonly Locale[] = ['ko', 'en'];

/** A UI string, or a function that builds one from arguments (plurals, names...). */
export type StringValue = string | ((...args: never[]) => string);
export type StringDict = Readonly<Record<string, StringValue>>;

export interface StringTable<S extends StringDict> {
  readonly ko: S;
  readonly en: S;
}

/**
 * Declares the strings of one UI area. `en` is checked against the shape inferred from `ko`: a missing key, a key of a
 * different kind, or a function with other parameter types is a compile error (extra keys too, when written inline).
 * Annotate the parameters of functions in `ko` (`(n: number) => ...`); in `en` they are inferred from `ko`.
 *
 *   export const strings = defineStrings({
 *     ko: { title: '제목', count: (n: number) => `${n}개` },
 *     en: { title: 'Title', count: (n) => `${n} items` },
 *   });
 *   // in a component:  const t = useStrings(strings);  t.count(3)
 */
export function defineStrings<S extends StringDict>(table: { ko: S; en: NoInfer<S> }): StringTable<S> {
  return table;
}

export function getStrings<S extends StringDict>(table: StringTable<S>, locale: Locale): S {
  return table[locale];
}

/**
 * The language preference + the browser language -> the language actually used. An explicit preference always wins. For 'auto':
 * 'ko*' => 'ko', any other known language => 'en', and no language information at all => 'ko' (the product default).
 */
export function resolveLocale(pref: 'auto' | Locale, browserLanguage: string | null | undefined): Locale {
  if (pref !== 'auto') return pref;
  const language = typeof browserLanguage === 'string' ? browserLanguage.trim().toLowerCase() : '';
  if (language === '') return 'ko';
  return language.startsWith('ko') ? 'ko' : 'en';
}

function firstLanguage(candidates: readonly (string | null | undefined)[]): string | undefined {
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() !== '') ?? undefined;
}

/**
 * docs/PLAN.md §7.4: the app language is `settings.language`; 'auto' follows the Discord page language (`dce.theme` -> `lang`,
 * written by the content script) and, when the user never opened Discord, the browser UI language (`chrome.i18n.getUILanguage()`).
 */
export function resolveUiLocale(
  pref: 'auto' | Locale,
  discordLanguage: string | null | undefined,
  uiLanguage: string | null | undefined,
): Locale {
  if (pref !== 'auto') return pref;
  return resolveLocale('auto', firstLanguage([discordLanguage, uiLanguage]));
}
