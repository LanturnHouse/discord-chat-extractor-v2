/**
 * The toolbar badge (docs/PLAN.md §7.2, #2):
 *  - a job is running -> `done/total` (as a percentage when that text would be longer than 4 characters);
 *  - a job ended with failures and the popup has not been opened since -> a red `!`;
 *  - otherwise -> the number of chats in the current account's list (blank when it is empty).
 * `refreshBadge` recomputes it from storage; the worker calls it whenever the queue, the job, the account or the failure flag
 * changes (`chrome.storage.onChanged`), so every writer is covered without remembering to update the badge.
 */
import { LOCAL, SESSION } from '@/shared';
import type { JobState } from '@/shared';
import { BG_STATE_KEY, isActiveJob, readAccount, readBgState, readJob, readQueue } from './store';
import { isTerminalStatus } from './validate';

export const BADGE_COLOR = '#5865F2';
export const BADGE_ALERT_COLOR = '#D83C3E';
const MAX_BADGE_CHARS = 4;
const MAX_QUEUE_BADGE = 999;
/** `dce.queue.` - every account's queue key starts with it. */
const QUEUE_PREFIX = LOCAL.queue('');

export interface BadgeView {
  text: string;
  color: string;
}

/** Pure: what the badge shows for a job (if running), the failure flag and the queue size. */
export function computeBadge(input: { job: JobState | null; alert: boolean; queueCount: number }): BadgeView {
  const { job, alert, queueCount } = input;
  if (isActiveJob(job)) {
    const total = job.items.length;
    const done = job.items.filter((item) => isTerminalStatus(item.status)).length;
    let text = `${done}/${total}`;
    if (text.length > MAX_BADGE_CHARS) text = total === 0 ? '' : `${Math.floor((done / total) * 100)}%`;
    return { text, color: BADGE_COLOR };
  }
  if (alert) return { text: '!', color: BADGE_ALERT_COLOR };
  if (queueCount <= 0) return { text: '', color: BADGE_COLOR };
  return { text: queueCount > MAX_QUEUE_BADGE ? `${MAX_QUEUE_BADGE}+` : String(queueCount), color: BADGE_COLOR };
}

/** Does a `chrome.storage.onChanged` event concern the badge? */
export function affectsBadge(changes: Record<string, unknown>, areaName: string): boolean {
  const keys = Object.keys(changes);
  if (areaName === 'session') return keys.some((key) => key === SESSION.job || key === SESSION.account || key === BG_STATE_KEY);
  if (areaName === 'local') return keys.some((key) => key.startsWith(QUEUE_PREFIX));
  return false;
}

let applied: BadgeView | null = null;
let running = false;
let dirty = false;

async function applyBadge(): Promise<void> {
  const [job, state, account] = await Promise.all([readJob(), readBgState(), readAccount()]);
  const queueCount = account === null ? 0 : (await readQueue(account.id)).length;
  const view = computeBadge({ job, alert: state.alert, queueCount });
  if (applied !== null && applied.text === view.text && applied.color === view.color) return;
  await chrome.action.setBadgeText({ text: view.text });
  if (view.text !== '') await chrome.action.setBadgeBackgroundColor({ color: view.color });
  applied = view;
}

/** Recomputes and applies the badge. Calls overlap safely (a call during a run makes it run once more); never rejects. */
export async function refreshBadge(): Promise<void> {
  if (running) {
    dirty = true;
    return;
  }
  running = true;
  try {
    do {
      dirty = false;
      try {
        await applyBadge();
      } catch {
        // the badge is cosmetic
      }
    } while (dirty);
  } finally {
    running = false;
  }
}

/** Forgets what was applied last (tests; a worker restart does the same). */
export function resetBadgeState(): void {
  applied = null;
  running = false;
  dirty = false;
}
