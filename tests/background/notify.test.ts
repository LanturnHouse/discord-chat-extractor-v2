/** The completion notification (#9): text, button, and what a click does (docs/PLAN.md §7.2). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL } from '@/shared';
import type { ItemProgress } from '@/shared';
import { notificationId, parseNotificationId } from '@/background/notify';
import { EXTENSION_URL, createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  CHANNEL_A,
  CHANNEL_B,
  CHANNEL_C,
  bootLoggedIn,
  guildTarget,
  installEngine,
  queueItem,
  scriptedEngine,
  seedConsent,
  seedQueue,
  settle,
  snapshot,
  startJobWith,
  waitFor,
} from './helpers';
import type { ScriptedEngine } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let engine: ScriptedEngine;
let jobId: string;

const cdn = 'https://cdn.discordapp.com/attachments/1/2/a.png';
const notice = () => fake.notifications.created[fake.notifications.created.length - 1];

async function startAndFinish(
  language: 'ko' | 'en' | 'auto',
  statuses: Record<string, Partial<ItemProgress>>,
  final: 'done' | 'cancelled' | 'failed' = 'done',
  options: { download?: boolean; settings?: Record<string, unknown> } = {},
): Promise<void> {
  seedConsent(fake, { language, ...options.settings });
  seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B)), queueItem(guildTarget(CHANNEL_C))]);
  jobId = await startJobWith(popup, engine);
  if (options.download) await engine.io!.saveUrl(jobId, CHANNEL_A, cdn, 'f/a.png');
  await engine.io!.progress(snapshot(engine.jobs[0], statuses));
  await engine.io!.finished(jobId, final);
}

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup } = await bootLoggedIn(fake));
  engine = scriptedEngine();
  installEngine(fake, { runner: engine.runner });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the notification says', () => {
  const allDone = {
    [CHANNEL_A]: { status: 'done' as const, fetched: 1000 },
    [CHANNEL_B]: { status: 'done' as const, fetched: 234 },
    [CHANNEL_C]: { status: 'done' as const, fetched: 0 },
  };

  it('Korean: "다운로드 완료" and "채팅 n개 · 메시지 m개" with a "폴더 열기" button', async () => {
    await startAndFinish('ko', allDone);
    expect(notice().options).toEqual({
      type: 'basic',
      iconUrl: `${EXTENSION_URL}icons/icon128.png`,
      title: '다운로드 완료',
      message: '채팅 3개 · 메시지 1,234개',
      buttons: [{ title: '폴더 열기' }],
      priority: 0,
    });
  });

  it('English: "Download complete", "n chats · m messages", an "Open folder" button', async () => {
    await startAndFinish('en', allDone);
    expect(notice().options).toMatchObject({ title: 'Download complete', message: '3 chats · 1,234 messages', buttons: [{ title: 'Open folder' }] });
  });

  it('English singular', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'done', fetched: 1 }, [CHANNEL_B]: { status: 'failed' }, [CHANNEL_C]: { status: 'failed' } });
    expect(notice().options).toMatchObject({ message: '1 chat · 1 message' });
  });

  it('"일부 실패" / "Some downloads failed" when any chat failed or was saved only in part', async () => {
    await startAndFinish('ko', { [CHANNEL_A]: { status: 'done', fetched: 5 }, [CHANNEL_B]: { status: 'failed' }, [CHANNEL_C]: { status: 'done', fetched: 5 } });
    expect(notice().options).toMatchObject({ title: '일부 실패', message: '채팅 2개 · 메시지 10개' });
  });

  it('counts a partially saved chat (it produced a file) but not a failed one', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'partial', fetched: 40 }, [CHANNEL_B]: { status: 'failed', fetched: 3 }, [CHANNEL_C]: { status: 'done', fetched: 10 } });
    expect(notice().options).toMatchObject({ title: 'Some downloads failed', message: '2 chats · 50 messages' });
  });

  it('says so when every chat failed', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'failed' }, [CHANNEL_B]: { status: 'failed' }, [CHANNEL_C]: { status: 'failed' } });
    expect(notice().options).toMatchObject({ title: 'Some downloads failed', message: '0 chats · 0 messages' });
  });

  it('a job that failed as a whole is reported as a failure too', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'done', fetched: 2 } }, 'failed');
    expect(notice().options).toMatchObject({ title: 'Some downloads failed' });
  });

  it('"auto" follows the Discord page language, like the exported files', async () => {
    fake.local.seed({ [LOCAL.theme]: { scheme: 'dark', themeClasses: [], vars: {}, lang: 'ko', capturedAt: 1 } });
    await startAndFinish('auto', allDone);
    expect(notice().options).toMatchObject({ title: '다운로드 완료' });
  });

  it('is silent when the user switched notifications off', async () => {
    await startAndFinish('en', allDone, 'done', { settings: { notifyOnComplete: false } });
    await settle();
    expect(fake.notifications.created).toEqual([]);
  });

  it('is silent when the user cancelled', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'done', fetched: 4 }, [CHANNEL_B]: { status: 'running' } }, 'cancelled');
    await settle();
    expect(fake.notifications.created).toEqual([]);
  });

  it('is shown once per job', async () => {
    await startAndFinish('en', allDone);
    await engine.io!.finished(jobId, 'done');
    await settle();
    expect(fake.notifications.created).toHaveLength(1);
  });

  it('does not let a notification failure break the end of the job', async () => {
    vi.mocked(chrome.notifications.create).mockRejectedValueOnce(new Error('Notifications are disabled'));
    await startAndFinish('en', allDone);
    await settle();
    expect(fake.session.peek<{ state: string }>('dce.job')?.state).toBe('done');
  });
});

describe('the "open folder" button and a click on the notification', () => {
  it('reveals the last file the job saved', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'done', fetched: 1 } }, 'done', { download: true });
    const { id } = notice();
    expect(id).toMatch(/^dce\.done\.1\./);
    fake.clickNotificationButton(id, 0);
    await waitFor(() => fake.downloads.shown.length === 1);
    expect(fake.downloads.shown).toEqual([1]);
    await waitFor(() => fake.notifications.cleared.includes(id));
  });

  it('a click on the notification itself does the same', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'done', fetched: 1 } }, 'done', { download: true });
    fake.clickNotification(notice().id);
    await waitFor(() => fake.downloads.shown.length === 1);
    expect(fake.downloads.shown).toEqual([1]);
  });

  it('shows the downloads folder when the job saved nothing', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'failed' }, [CHANNEL_B]: { status: 'failed' }, [CHANNEL_C]: { status: 'failed' } });
    expect(notice().id).toMatch(/^dce\.done\.none\./);
    fake.clickNotificationButton(notice().id, 0);
    await waitFor(() => fake.downloads.defaultFolderShown === 1);
    expect(fake.downloads.shown).toEqual([]);
  });

  it('falls back to the downloads folder when the file cannot be shown any more', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'done', fetched: 1 } }, 'done', { download: true });
    vi.mocked(chrome.downloads.show).mockImplementationOnce(() => {
      throw new Error('Invalid download id');
    });
    fake.clickNotificationButton(notice().id, 0);
    await waitFor(() => fake.downloads.defaultFolderShown === 1);
  });

  it('knows its download from the notification id alone (it works for a worker that just woke up)', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'done', fetched: 1 } }, 'done', { download: true });
    const { id } = notice();
    fake.onNotificationButtonClicked.dispatch('dce.done.1.some-job', 0);
    fake.onNotificationClicked.dispatch(id);
    await waitFor(() => fake.downloads.shown.length === 2);
    expect(fake.downloads.shown).toEqual([1, 1]);
  });

  it('ignores notifications that are not ours, and buttons that do not exist', async () => {
    await startAndFinish('en', { [CHANNEL_A]: { status: 'done', fetched: 1 } }, 'done', { download: true });
    fake.clickNotificationButton('someone-elses-notification', 0);
    fake.clickNotification('dce.other.1.x');
    fake.clickNotification('dce.done.abc.x');
    fake.clickNotificationButton(notice().id, 1);
    await settle();
    expect(fake.downloads.shown).toEqual([]);
    expect(fake.downloads.defaultFolderShown).toBe(0);
    expect(fake.notifications.cleared).toEqual([]);
  });
});

describe('notification ids', () => {
  it('carry the download id (or "none") and the job id', () => {
    expect(notificationId('job-1', 7)).toBe('dce.done.7.job-1');
    expect(notificationId('job-1', null)).toBe('dce.done.none.job-1');
    expect(notificationId('job-1', 0)).toBe('dce.done.0.job-1');
  });

  it('parse back to the download id, or null for none, or undefined for a foreign id', () => {
    expect(parseNotificationId('dce.done.7.job-1')).toBe(7);
    expect(parseNotificationId('dce.done.0.job-1')).toBe(0);
    expect(parseNotificationId('dce.done.none.job-1')).toBeNull();
    for (const id of ['', 'dce.done.', 'dce.done.x.job', 'dce.done.-1.job', 'dce.other.7.job', 'something']) {
      expect(parseNotificationId(id)).toBeUndefined();
    }
  });
});
