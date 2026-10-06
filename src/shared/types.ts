/**
 * Shared data model (docs/PLAN.md §5.1). CONTRACT: owned by the main agent - propose changes in your report, do not edit.
 * Kept in sync with the plan by tests/shared/contractSync.test.ts.
 */

export type ExportFormat = 'txt' | 'html' | 'md' | 'xlsx' | 'csv' | 'json';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['html', 'txt', 'md', 'xlsx', 'csv', 'json'];

export type ChatKind = 'guild-channel' | 'thread' | 'forum' | 'dm' | 'group-dm';

export interface ChatTarget {
  kind: ChatKind;
  channelId: string;
  guildId: string | null;        // DM/그룹 DM은 null
  guildName: string | null;      // 예: "예시서버"
  channelName: string;           // '#' 없는 채널명 또는 DM 표시 이름
  parentId?: string | null;      // 카테고리 id(채널) 또는 부모 채널 id(스레드)
  parentName?: string | null;
  channelType?: number;          // 알면 디스코드 채널 타입(0,2,4,5,10,11,12,13,15,16,1,3)
  iconUrl?: string | null;       // 목록 표시용 DM 아바타/서버 아이콘
}

export interface ContentOptions {
  includeBots: boolean;          // 기본 true
  includeSystem: boolean;        // 기본 true
  includeReactions: boolean;     // 기본 true
  includeEmbeds: boolean;        // 기본 true
}

export interface ExportSettings {
  count: number | null;          // null = 전체. 기본 200. 정수 1..1_000_000
  from: string | null;           // ISO8601 UTC, 포함 하한(시작일 00:00:00.000 로컬). null = 무제한
  to: string | null;             // ISO8601 UTC, 포함 상한(종료일 23:59:59.999 로컬). null = 지금
  format: ExportFormat;          // 기본 'html'
  htmlTheme: 'dark' | 'light';   // HTML일 때만 의미. 기본 'dark'
  includeAttachments: boolean;   // #6 기본 false
  includeThreads: boolean;       // #10 기본 false (포럼/미디어 채널은 항상 스레드 단위)
  incremental: boolean;          // #14 기본 false
  content: ContentOptions;       // #12
}

export interface QueueItem {
  key: string;                   // = target.channelId (계정 안에서 유일)
  target: ChatTarget;
  settings: ExportSettings | null; // null = 공통 설정(AppSettings.common)을 따름. 값이 있으면 개별 설정
  addedAt: number;               // epoch ms
  lastResult?: { status: 'partial' | 'failed' | 'cancelled'; message: string; at: number } | null; // 재시도 표시용
}

/** 작업 시작 시 유효 설정을 확정한 항목 (settings = item.settings ?? common) */
export interface ResolvedQueueItem {
  key: string;
  target: ChatTarget;
  settings: ExportSettings;
}

export interface AccountInfo {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string;             // 기본 아바타 포함 완성된 CDN URL
}

export interface AppSettings {
  common: ExportSettings;        // 공통 다운로드 설정 (#7)
  showButtons: boolean;          // 기본 true
  showQueuedIndicator: boolean;  // 사용 안 함(4차 변경: 버튼이 항상 보임). 값은 무시
  zipAll: boolean;               // #8 기본 false
  folderName: string;            // 기본 "Discord Export"
  dateInFileName: boolean;       // 기본 true
  timeZone: string;              // 'auto' 또는 IANA
  notifyOnComplete: boolean;     // #9 기본 true
  language: 'auto' | 'ko' | 'en';// #18 기본 'auto' (앱 화면 + 내보낸 파일 고정 문구)
  consentAt: number | null;      // #11 동의 시각
}

export type ItemStatus = 'waiting' | 'running' | 'paused' | 'done' | 'partial' | 'failed' | 'cancelled';
export type ItemPhase = 'resolving' | 'messages' | 'threads' | 'attachments' | 'writing' | 'saving';
export type ErrorKind = 'auth' | 'forbidden' | 'not-found' | 'rate-limited' | 'blocked' | 'network' | 'server' | 'cancelled' | 'interrupted' | 'unknown';

export interface ItemProgress {
  key: string;
  label: string;                 // 예: "예시서버 > #일반" / "친구"
  status: ItemStatus;
  phase: ItemPhase | null;
  fetched: number;
  expected: number | null;       // 개수 제한이 있으면 그 값
  error: { kind: ErrorKind; message: string } | null;
  files: string[];               // 저장된 상대 경로
}

export interface JobState {
  jobId: string;
  accountId: string;
  startedAt: number;
  finishedAt: number | null;
  state: 'running' | 'paused' | 'done' | 'cancelled' | 'failed';
  pausedReason: 'rate-limit' | null;
  zip: boolean;
  items: ItemProgress[];
}

export interface HistoryEntry {
  id: string;
  accountId: string;
  target: ChatTarget;
  settings: ExportSettings;      // 실제로 쓰인 유효 설정
  finishedAt: number;
  status: 'done' | 'partial' | 'failed';
  messageCount: number;
  files: { filename: string; downloadId: number | null }[];
  error: string | null;
}

export interface InjectHealth { ok: boolean; reason: string | null; checkedAt: number; url: string }

/** 유효 설정이 어디서 왔는지 (5차): 항목 개별 > 카테고리 > 서버 > 공통 */
export type SettingsSource = 'item' | 'category' | 'guild' | 'common';

/** 카테고리·서버 버튼의 체크 상태 계산용: 그룹 안에서 내가 볼 수 있는 채널 목록 (bg가 권한 계산 후 기록) */
export interface GroupInfo {
  kind: 'category' | 'guild';
  guildId: string;
  channelIds: string[];          // 볼 수 있는 타입 0·5·15·16 채널, 사이드바 순서
  updatedAt: number;             // epoch ms
  name?: string | null;          // (5차) 서버/카테고리 이름 — 팝업 트리 표시용
  iconUrl?: string | null;       // (5차) 서버 아이콘 URL(64px png). 카테고리는 없음
}

export interface ThemeTokens {
  scheme: 'dark' | 'light';
  themeClasses: string[];        // 예: ['theme-dark','theme-midnight']
  vars: Record<string, string>;  // §4 변수 이름 → computed 값
  lang: string;                  // document.documentElement.lang (예: 'ko')
  capturedAt: number;
}
