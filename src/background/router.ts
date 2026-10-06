/**
 * `chrome.runtime.onMessage` (docs/PLAN.md §5.3, §8). Only messages addressed `to: 'bg'` are handled (anything else is not
 * ours: no answer); every one is answered with a `BgResponse` asynchronously.
 *
 * Who may send what:
 *  - nobody whose `sender.id` is not this extension;
 *  - the offscreen document (`offscreen.html`): the `engine/*` messages, and nothing else;
 *  - other extension pages (the popup): every other message (so `queue/setGroupSettings` and `queue/removeMany` are theirs alone);
 *  - content scripts (`sender.tab` and a Discord origin as `sender.url`): `queue/toggle`, `queue/addCategory`,
 *    `queue/addGuild`, `queue/groupInfo`, `inject/health` and nothing else.
 */
import type { BgResponse } from '@/shared';
import { clearHistory, readAccount } from './store';
import { cancelJob, rerunFromHistory, startJob } from './jobs';
import { ENGINE_MESSAGE_TYPES, handleEngineMessage } from './engine';
import { showDownload } from './downloads';
import { recordHealth } from './health';
import { whenBooted } from './lifecycle';
import { OFFSCREEN_PATH } from './offscreen';
import { addCategory, addGuild, clearQueue, groupInfo, removeMany, removeQueueItem, setGroupSettings, toggleQueue, upsertQueueItem } from './queue';
import { fail, invalid, ok } from './response';
import { getStatus, patchSettingsMessage } from './status';
import { isDiscordUrl, openDiscord } from './tabs';
import { describeError, isRecord } from './util';

/** Message types a content script may send. */
export const CONTENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'queue/toggle',
  'queue/addCategory',
  'queue/addGuild',
  'queue/groupInfo',
  'inject/health',
]);

export type SenderKind = 'offscreen' | 'extension' | 'content';

/** Who sent this? null = nobody we talk to. */
export function classifySender(sender: chrome.runtime.MessageSender): SenderKind | null {
  if (sender.id !== chrome.runtime.id) return null;
  const url = sender.url;
  if (typeof url !== 'string') return null;
  const base = chrome.runtime.getURL('');
  if (url.startsWith(base)) {
    const path = url.slice(base.length).split(/[?#]/, 1)[0];
    return path === OFFSCREEN_PATH ? 'offscreen' : 'extension';
  }
  if (sender.tab !== undefined && isDiscordUrl(url)) return 'content';
  return null;
}

async function clearHistoryMessage(): Promise<BgResponse> {
  const account = await readAccount();
  if (account === null) return fail('no-account');
  await clearHistory(account.id);
  return ok();
}

async function handleBackgroundMessage(type: string, message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<BgResponse<unknown>> {
  switch (type) {
    case 'queue/toggle':
      return toggleQueue(message.target);
    case 'queue/addCategory':
      return addCategory(message);
    case 'queue/addGuild':
      return addGuild(message);
    case 'queue/groupInfo':
      return groupInfo(message);
    case 'queue/upsert':
      return upsertQueueItem(message.item);
    case 'queue/setGroupSettings':
      return setGroupSettings(message);
    case 'queue/remove':
      return removeQueueItem(message.key);
    case 'queue/removeMany':
      return removeMany(message.keys);
    case 'queue/clear':
      return clearQueue();
    case 'settings/patch':
      return patchSettingsMessage(message.patch);
    case 'job/start':
      return startJob(message.keys);
    case 'job/cancel':
      return cancelJob();
    case 'history/rerun':
      return rerunFromHistory(message.id);
    case 'history/clear':
      return clearHistoryMessage();
    case 'downloads/show':
      return showDownload(message.downloadId);
    case 'discord/open':
      return openDiscord();
    case 'status/get':
      return getStatus();
    case 'inject/health':
      return recordHealth(message.health, sender);
    default:
      return invalid('unknown message type');
  }
}

/** Checks the sender, runs the handler, never rejects. */
export async function dispatch(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<BgResponse<unknown>> {
  const kind = classifySender(sender);
  if (kind === null) return invalid('sender not allowed');
  const type = message.type;
  if (typeof type !== 'string') return invalid('message has no type');

  const isEngineMessage = ENGINE_MESSAGE_TYPES.has(type);
  if (kind === 'offscreen' ? !isEngineMessage : isEngineMessage) return invalid('sender not allowed for this message');
  if (kind === 'content' && !CONTENT_MESSAGE_TYPES.has(type)) return invalid('sender not allowed for this message');

  try {
    return isEngineMessage ? await handleEngineMessage(message) : await handleBackgroundMessage(type, message, sender);
  } catch (error) {
    return fail('unknown', describeError(error));
  }
}

/**
 * The listener. It must say synchronously (by returning true) that it will answer later; a message that is not for the
 * background (`to` is something else, or not a message at all) is left alone.
 */
export function onMessage(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean {
  if (!isRecord(message) || message.to !== 'bg') return false;
  void whenBooted()
    .then(() => dispatch(message, sender))
    .then((response) => {
      try {
        sendResponse(response);
      } catch {
        // the sender went away (popup closed) before the answer was ready
      }
    });
  return true;
}
