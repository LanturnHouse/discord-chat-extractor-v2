/**
 * Tooltip and toast texts (ko / en). Same rule as the rest of the extension (docs/PLAN.md §7.4): an explicit
 * `settings.language` wins; 'auto' follows the page language (`<html lang>`, the same value stored as `dce.theme.lang`),
 * then the browser UI language. `defineStrings` makes a key missing in one language a compile error (v1's technique).
 */

export type Lang = 'ko' | 'en';
export const LANGS: readonly Lang[] = ['ko', 'en'];

type StringValue = string | ((...args: never[]) => string);
type StringDict = Readonly<Record<string, StringValue>>;

interface StringTable<S extends StringDict> {
  readonly ko: S;
  readonly en: S;
}

/** `en` is checked against the shape inferred from `ko`: a missing key or another parameter list does not compile. */
function defineStrings<S extends StringDict>(table: { ko: S; en: NoInfer<S> }): StringTable<S> {
  return table;
}

export const strings = defineStrings({
  ko: {
    // button tooltips + aria-labels (PLAN §7.1)
    tooltipAdd: '다운로드 목록에 추가',
    tooltipRemove: '다운로드 목록에서 빼기',
    // category / server buttons are toggles: the text follows the check state (add while unchecked, remove while checked)
    tooltipCategory: '이 카테고리 채널 전부 추가',
    tooltipCategoryRemove: '이 카테고리 채널 전부 빼기',
    tooltipGuild: '이 서버 채널 전부 추가',
    tooltipGuildRemove: '이 서버 채널 전부 빼기',
    // toasts
    toastAdded: '다운로드 목록에 추가했어요 · 공통 설정',
    toastRemoved: '목록에서 뺐어요',
    // also what the server button says when it added / removed something
    toastCategoryAdded: (count: number) => `채널 ${count}개를 추가했어요`,
    toastCategoryRemoved: (count: number) => `채널 ${count}개를 목록에서 뺐어요`,
    toastCategoryNothing: '추가할 새 채널이 없어요',
    toastGuildNothing: '추가할 채널이 없어요 (이미 모두 목록에 있어요)',
    toastNoAccount: '디스코드 계정을 확인하는 중이에요. 잠시 후 다시 눌러 주세요',
    toastNoConsent: '확장 프로그램 아이콘을 눌러 안내를 먼저 확인해 주세요',
    toastBusy: '다른 작업을 처리하는 중이에요. 잠시 후 다시 눌러 주세요',
    toastEmpty: '이 카테고리에는 담을 채널이 없어요',
    toastEmptyGuild: '이 서버에는 담을 채널이 없어요',
    toastHttp: '디스코드에서 정보를 가져오지 못했어요. 잠시 후 다시 시도해 주세요',
    toastNoChat: '지금 보고 있는 채팅이 없어요',
    toastOffline: '확장 프로그램과 연결하지 못했어요. 디스코드를 새로고침해 주세요',
    toastError: '문제가 생겼어요. 잠시 후 다시 시도해 주세요',
  },
  en: {
    tooltipAdd: 'Add to download list',
    tooltipRemove: 'Remove from download list',
    tooltipCategory: 'Add every channel in this category',
    tooltipCategoryRemove: 'Remove every channel in this category',
    tooltipGuild: 'Add every channel in this server',
    tooltipGuildRemove: 'Remove every channel in this server',
    toastAdded: 'Added to the download list · common settings',
    toastRemoved: 'Removed from the list',
    toastCategoryAdded: (count) => (count === 1 ? 'Added 1 channel' : `Added ${count} channels`),
    toastCategoryRemoved: (count) => (count === 1 ? 'Removed 1 channel from the list' : `Removed ${count} channels from the list`),
    toastCategoryNothing: 'No new channels to add',
    toastGuildNothing: 'Nothing to add (every channel is already in the list)',
    toastNoAccount: 'Checking your Discord account. Try again in a moment',
    toastNoConsent: 'Click the extension icon and read the notice first',
    toastBusy: 'Busy with another task. Try again in a moment',
    toastEmpty: 'This category has no channels to add',
    toastEmptyGuild: 'This server has no channels to add',
    toastHttp: "Couldn't get the information from Discord. Try again in a moment",
    toastNoChat: 'No chat is open right now',
    toastOffline: "Couldn't reach the extension. Reload Discord",
    toastError: 'Something went wrong. Try again in a moment',
  },
});

export type Strings = (typeof strings)['ko'];

/** The language to use: an explicit choice, else the page language, else the browser UI language, else Korean. */
export function resolveLang(
  preference: 'auto' | Lang,
  pageLang: string | null | undefined,
  uiLang: string | null | undefined,
): Lang {
  if (preference === 'ko' || preference === 'en') return preference;
  const lang = (pageLang || uiLang || '').trim().toLowerCase();
  if (lang === '') return 'ko';
  return lang.startsWith('ko') ? 'ko' : 'en';
}
