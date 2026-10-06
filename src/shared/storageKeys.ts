/**
 * Storage key names (docs/PLAN.md §5.2). CONTRACT: owned by the main agent - propose changes in your report, do not edit.
 * Kept in sync with the plan by tests/shared/contractSync.test.ts.
 */

// chrome.storage.session — 메모리 전용. 접근 레벨 TRUSTED_CONTEXTS(기본) 유지 → 콘텐츠 스크립트는 읽을 수 없음
export const SESSION = {
  token: 'dce.token',
  tokenCapturedAt: 'dce.tokenCapturedAt',
  account: 'dce.account',            // AccountInfo | null (현재 토큰의 계정)
  job: 'dce.job',                    // JobState | null
  injectHealth: 'dce.injectHealth',  // Record<string(tabId), InjectHealth>
} as const;
// chrome.storage.local — 콘텐츠 스크립트도 읽기 가능. 쓰기는 bg만 (예외: theme, classCache는 콘텐츠가 직접 씀)
export const LOCAL = {
  settings: 'dce.settings',                                   // AppSettings
  queue: (accountId: string) => `dce.queue.${accountId}`,     // QueueItem[]
  history: (accountId: string) => `dce.history.${accountId}`, // HistoryEntry[] 최신순, 최대 200
  lastExported: (accountId: string) => `dce.lastExported.${accountId}`, // Record<channelId, messageId>
  lastAccount: 'dce.lastAccount',                             // AccountInfo | null
  theme: 'dce.theme',                                         // ThemeTokens
  classCache: 'dce.classCache',                               // { channelIcon?: string; channelSvg?: string; dmButton?: string; dmSvg?: string }
  groups: (accountId: string) => `dce.groups.${accountId}`,   // Record<groupId(카테고리 id 또는 서버 id), GroupInfo>
  groupSettings: (accountId: string) => `dce.groupSettings.${accountId}`, // (5차) Record<groupId(서버 id 또는 카테고리 id), ExportSettings> 서버·카테고리 설정
  uiExpanded: 'dce.ui.expanded',                              // (5차) string[] 팝업 트리에서 펼친 그룹 id. UI 전용이라 팝업이 직접 기록
} as const;
