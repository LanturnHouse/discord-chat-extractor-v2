/**
 * Runtime messages between extension contexts (docs/PLAN.md §5.3). CONTRACT: owned by the main agent - propose changes
 * in your report, do not edit. Kept in sync with the plan by tests/shared/contractSync.test.ts.
 */
import type {
  AccountInfo,
  AppSettings,
  ChatTarget,
  ExportSettings,
  HistoryEntry,
  InjectHealth,
  JobState,
  QueueItem,
  ResolvedQueueItem,
} from './types';

export type BgError = 'no-account' | 'no-consent' | 'busy' | 'empty' | 'invalid' | 'forbidden-path' | 'http' | 'unknown';
export type BgResponse<T = undefined> = { ok: true; data: T } | { ok: false; error: BgError; message?: string };

export interface StatusSnapshot {
  account: AccountInfo | null;       // 현재 토큰 기준 확인된 계정. null = 아직 없음
  lastAccount: AccountInfo | null;
  discordTabs: number;               // 열린 디스코드 탭 수 (chrome.tabs.query URL 필터)
  health: InjectHealth | null;       // 가장 최근 보고
  job: JobState | null;
}

/** popup / content → background */
export type ToBackground =
  | { to: 'bg'; type: 'queue/toggle'; target: ChatTarget }              // 콘텐츠 행 버튼·단축키 → BgResponse<{ queued: boolean }>
  | { to: 'bg'; type: 'queue/addCategory'; guildId: string; guildName: string | null; categoryId: string; categoryName: string } // #13 토글 → BgResponse<{ added: number; skipped: number; removed: number }>
  | { to: 'bg'; type: 'queue/addGuild'; guildId: string; guildName: string | null }                   // 서버 버튼 토글 → BgResponse<{ added: number; skipped: number; removed: number }>
  | { to: 'bg'; type: 'queue/groupInfo'; guildId: string; guildName: string | null }                 // 콘텐츠가 서버를 볼 때 → bg가 LOCAL.groups 갱신 → BgResponse
  | { to: 'bg'; type: 'queue/upsert'; item: QueueItem }                 // 팝업 ⚙ 저장(settings null = 상위 설정(카테고리→서버→공통)을 따르도록 되돌리기)
  | { to: 'bg'; type: 'queue/setGroupSettings'; kind: 'guild' | 'category'; guildId: string; groupId: string; settings: ExportSettings | null } // (5차) 서버·카테고리 ⚙ 저장 → BgResponse<{ cleared: number }>
  | { to: 'bg'; type: 'queue/removeMany'; keys: string[] }               // (5차) 그룹 ✕ → BgResponse<{ removed: number }>
  | { to: 'bg'; type: 'queue/remove'; key: string }
  | { to: 'bg'; type: 'queue/clear' }
  | { to: 'bg'; type: 'settings/patch'; patch: Partial<AppSettings> }   // common은 통째로 교체
  | { to: 'bg'; type: 'job/start'; keys: string[] | 'all' }             // → BgResponse<{ jobId: string }>
  | { to: 'bg'; type: 'job/cancel' }
  | { to: 'bg'; type: 'history/rerun'; id: string }                     // → BgResponse<{ jobId: string }>
  | { to: 'bg'; type: 'history/clear' }
  | { to: 'bg'; type: 'downloads/show'; downloadId: number | null }     // null = 기본 다운로드 폴더
  | { to: 'bg'; type: 'discord/open' }
  | { to: 'bg'; type: 'status/get' }                                    // → BgResponse<StatusSnapshot>
  | { to: 'bg'; type: 'inject/health'; health: InjectHealth };

/** background → content (chrome.tabs.sendMessage) */
export type ToContent =
  | { to: 'content'; type: 'shortcut/toggleCurrent' };

/** background ↔ offscreen */
export interface EngineJob {
  jobId: string;
  accountId: string;
  authorization: string;                           // bg 세션 저장값 그대로. 엔진 메모리에만, 로그·에러·파일 금지
  items: ResolvedQueueItem[];
  settings: AppSettings;
  lastExported: Record<string, string>;
  locale: 'ko' | 'en';
  timeZone: string;                                // 'auto'를 이미 실제 IANA로 풀어서 전달
}
export type ToOffscreen =
  | { to: 'offscreen'; type: 'engine/run'; job: EngineJob }
  | { to: 'offscreen'; type: 'engine/cancel'; jobId: string }
  | { to: 'offscreen'; type: 'engine/revoke'; url: string };
export type FromOffscreen =
  | { to: 'bg'; type: 'engine/ready' }
  | { to: 'bg'; type: 'engine/authError'; jobId: string }            // 401 → bg가 같은 값일 때만 세션 인증값 삭제
  | { to: 'bg'; type: 'engine/progress'; job: JobState }
  | { to: 'bg'; type: 'engine/saveBlob'; jobId: string; itemKey: string | null; url: string; filename: string }  // → BgResponse<{ downloadId: number }>
  | { to: 'bg'; type: 'engine/saveUrl'; jobId: string; itemKey: string; url: string; filename: string }         // 첨부(개별 파일 모드) → BgResponse<{ downloadId: number }>
  | { to: 'bg'; type: 'engine/itemDone'; jobId: string; entry: HistoryEntry; lastMessageId: string | null }
  | { to: 'bg'; type: 'engine/finished'; jobId: string; state: JobState['state'] }
  | { to: 'bg'; type: 'engine/keepalive'; jobId: string };            // 20초마다 (긴 대기 중 SW 유지)
