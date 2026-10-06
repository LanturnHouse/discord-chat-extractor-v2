import type { Message } from '../discord/types';
import { displayName } from './names';
import { getStrings, type MessageLocale, type MessageStrings } from './strings';
import { oneLine } from './text';
import { timestampMs } from './time';

/** Types whose content was written by a person/app (rendered as a normal message): default, reply, slash command, thread starter, context-menu command. */
const USER_AUTHORED = new Set([0, 19, 20, 21, 23]);

/** Missing / garbage `type` is treated as a plain message rather than a system one. */
function typeOf(msg: Message): number {
  return typeof msg?.type === 'number' && Number.isFinite(msg.type) ? msg.type : 0;
}

export function isSystemMessage(msg: Message): boolean {
  return !USER_AUTHORED.has(typeOf(msg));
}

const NAME_MAX = 80;
const DETAIL_MAX = 120;

function actorName(msg: Message, s: MessageStrings): string {
  const name = msg.author ? oneLine(displayName(msg.author), NAME_MAX) : '';
  return name || s.unknownUser;
}

/** Free text from `content` (channel name, thread name, topic...) made safe for a single line; null when empty. */
function detail(msg: Message): string | null {
  return oneLine(msg.content, DETAIL_MAX) || null;
}

/** Boost count lives in `content` as a bare integer; anything else means "once". */
function boostCount(msg: Message): number | null {
  const raw = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

function targetName(msg: Message, s: MessageStrings): string {
  const target = msg.mentions?.[0];
  const name = target ? oneLine(displayName(target), NAME_MAX) : '';
  return name || s.someone;
}

function describeDuration(ms: number, s: MessageStrings): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return s.seconds(total);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return s.minutes(minutes);
  return s.hoursMinutes(Math.floor(minutes / 60), minutes % 60);
}

function callText(msg: Message, actor: string, s: MessageStrings): string {
  const ended = msg.call?.ended_timestamp;
  if (!ended) return s.callStarted(actor);
  // Nobody but the caller took part: the call rang out.
  const participants = msg.call?.participants;
  if (Array.isArray(participants) && !participants.some((id) => id !== msg.author?.id)) return s.callMissed(actor);
  const start = timestampMs(msg.timestamp);
  const end = timestampMs(ended);
  if (start === null || end === null || end < start) return s.callStarted(actor);
  return s.callLasted(actor, describeDuration(end - start, s));
}

/**
 * One-line, localised description of a system message, or null for user-authored messages.
 *
 * The author's display name appears wherever the event has a human actor. Discovery notices (14, 15) and the
 * invite reminder (22) have none — Discord itself shows them without a name — so they are name-less.
 */
export function systemMessageText(msg: Message, locale: MessageLocale): string | null {
  const type = typeOf(msg);
  if (USER_AUTHORED.has(type)) return null;

  const s = getStrings(locale);
  const actor = actorName(msg, s);

  switch (type) {
    case 1:
      return s.recipientAdd(actor, targetName(msg, s));
    case 2: {
      const target = msg.mentions?.[0];
      if (target && target.id === msg.author?.id) return s.recipientLeave(actor);
      return s.recipientRemove(actor, targetName(msg, s));
    }
    case 3:
      return callText(msg, actor, s);
    case 4:
      return s.channelName(actor, detail(msg));
    case 5:
      return s.channelIcon(actor);
    case 6:
      return s.pinned(actor);
    case 7:
      return s.joined(actor);
    case 8:
      return s.boost(actor, boostCount(msg));
    case 9:
    case 10:
    case 11:
      return s.boostTier(actor, boostCount(msg), type - 8);
    case 12:
      return s.followAdd(actor, detail(msg));
    case 14:
      return s.discoveryDisqualified;
    case 15:
      return s.discoveryRequalified;
    case 18:
      return s.threadCreated(actor, detail(msg));
    case 22:
      return s.inviteReminder;
    case 24:
      return s.autoMod(actor);
    case 25:
      return s.roleSubscription(actor);
    case 27:
      return s.stageStart(actor, detail(msg));
    case 28:
      return s.stageEnd(actor, detail(msg));
    case 29:
      return s.stageSpeaker(actor);
    case 30:
      return s.stageRaiseHand(actor);
    case 31:
      return s.stageTopic(actor, detail(msg));
    default:
      return s.genericSystem(String(type));
  }
}
