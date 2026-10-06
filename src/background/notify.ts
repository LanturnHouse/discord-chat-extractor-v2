/**
 * The completion notification (docs/PLAN.md §7.2, #9): "다운로드 완료" / "일부 실패", "채팅 n개 · 메시지 m개", one button "폴더 열기".
 * The button (and a click on the notification) reveals the job's last saved file; its download id travels in the notification
 * id (`dce.done.<downloadId|none>.<jobId>`), so a click that wakes a freshly started worker needs no other state.
 */
import type { JobState } from '@/shared';
import { hasFailures, summarizeJob } from './jobState';
import { resolveLocale } from './locale';
import type { Locale } from './locale';
import { showJobFolder } from './downloads';
import { readBgState, readSettings } from './store';

const NOTIFICATION_PREFIX = 'dce.done.';

interface Texts {
  done: string;
  failed: string;
  openFolder: string;
  summary(chats: string, messages: string, chatCount: number, messageCount: number): string;
}

const TEXTS: Record<Locale, Texts> = {
  ko: {
    done: '다운로드 완료',
    failed: '일부 실패',
    openFolder: '폴더 열기',
    summary: (chats, messages) => `채팅 ${chats}개 · 메시지 ${messages}개`,
  },
  en: {
    done: 'Download complete',
    failed: 'Some downloads failed',
    openFolder: 'Open folder',
    summary: (chats, messages, chatCount, messageCount) =>
      `${chats} ${chatCount === 1 ? 'chat' : 'chats'} · ${messages} ${messageCount === 1 ? 'message' : 'messages'}`,
  },
};

/** The id of the notification of a finished job; carries the id of its last download. */
export function notificationId(jobId: string, downloadId: number | null): string {
  return `${NOTIFICATION_PREFIX}${downloadId ?? 'none'}.${jobId}`;
}

/** The download id inside a notification id (`null` = none), or `undefined` when the id is not one of ours. */
export function parseNotificationId(id: string): number | null | undefined {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return undefined;
  const [downloadPart] = id.slice(NOTIFICATION_PREFIX.length).split('.');
  if (downloadPart === 'none') return null;
  return /^\d+$/.test(downloadPart) ? Number(downloadPart) : undefined;
}

/**
 * Shows the notification of a finished job when the user asked for them (`notifyOnComplete`). A cancelled job gets none (the
 * user was there). Never rejects: a notification that cannot be shown is not worth failing a job over.
 */
export async function notifyFinished(job: JobState): Promise<void> {
  if (job.state === 'cancelled') return;
  try {
    const settings = await readSettings();
    if (!settings.notifyOnComplete) return;
    const locale = await resolveLocale(settings.language);
    const bg = await readBgState();
    const { chats, messages } = summarizeJob(job);
    const texts = TEXTS[locale];
    const format = new Intl.NumberFormat(locale === 'ko' ? 'ko-KR' : 'en-US');
    await chrome.notifications.create(notificationId(job.jobId, bg.jobId === job.jobId ? bg.lastDownloadId : null), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: hasFailures(job) ? texts.failed : texts.done,
      message: texts.summary(format.format(chats), format.format(messages), chats, messages),
      buttons: [{ title: texts.openFolder }],
      priority: 0,
    });
  } catch {
    // notifications blocked by the OS or the browser
  }
}

/** A click on the notification or on its button: reveal the file, then dismiss the notification. */
export async function onNotificationActivated(id: string): Promise<void> {
  const downloadId = parseNotificationId(id);
  if (downloadId === undefined) return;
  await showJobFolder(downloadId);
  await chrome.notifications.clear(id).catch(() => undefined);
}
