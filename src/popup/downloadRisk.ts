import { resolveEffectiveSettings, type ExportSettings, type GroupMap, type GroupSettingsMap, type QueueItem } from '@/shared';

/*
 * The safety check before a big download. Discord limits accounts that make a lot of automated requests with a user token, so
 * a start that would run many chats, an unbounded chat, a huge number of messages or many chats with their threads asks the
 * person once before it begins. This module only decides; the popup shows the question (`RiskConfirm`).
 */

/** More chats than this in one start is a bulk download. */
export const RISK_MAX_CHATS = 10;
/** More requested messages than this (the sum of the counts of the chats, more than one chat) is a bulk download. */
export const RISK_MAX_MESSAGES = 20_000;
/** Including threads is fine for a few chats; for more than this many it multiplies the requests. */
export const RISK_MAX_CHATS_WITH_THREADS = 3;

export type RiskReason = 'many-chats' | 'unbounded' | 'many-messages' | 'threads';

export interface DownloadRisk {
  /** At least one reason applies: ask before starting. */
  risky: boolean;
  /** Why, always in the order many-chats, unbounded, many-messages, threads. */
  reasons: RiskReason[];
  /** How many chats the start would run. */
  chats: number;
  /** The sum of the counts that are set (a chat without a count adds nothing: it is the "unbounded" reason or has a start date); null when no chat has a count. */
  messageEstimate: number | null;
}

type RiskItem = Pick<QueueItem, 'key' | 'target' | 'settings'>;

/** A chat that has no end: every message, with no start date. (An end date alone does not bound it.) */
function isUnbounded(settings: Pick<ExportSettings, 'count' | 'from'>): boolean {
  return settings.count === null && settings.from === null;
}

/** The engine looks up threads only below a text channel (a forum is always thread by thread, a DM or a thread has none). */
function fetchesThreads(item: RiskItem, settings: Pick<ExportSettings, 'includeThreads'>): boolean {
  return settings.includeThreads && item.target.kind === 'guild-channel';
}

/**
 * What a start of `items` would do, judged on the EFFECTIVE settings each chat runs with (its own, else its category's, its
 * server's, else the common ones: `resolveEffectiveSettings`, the same rule the background applies when the job begins).
 *
 * Risky when any of these holds:
 * - more than `RISK_MAX_CHATS` chats ("many-chats");
 * - a chat with no count and no start date ("unbounded"), also for a single chat;
 * - the counts of the chats add up to more than `RISK_MAX_MESSAGES` ("many-messages"; not for a single chat: one chat is read
 *   slowly and steadily, its size alone is not a bulk download);
 * - a chat includes its threads while more than `RISK_MAX_CHATS_WITH_THREADS` chats are started ("threads").
 */
export function assessDownloadRisk(items: readonly RiskItem[], common: ExportSettings, groupSettings: GroupSettingsMap, groups: GroupMap): DownloadRisk {
  const chats = items.length;
  let unbounded = false;
  let threads = false;
  let counted = false;
  let sum = 0;
  for (const item of items) {
    const { settings } = resolveEffectiveSettings(item, common, groupSettings, groups);
    if (isUnbounded(settings)) unbounded = true;
    if (fetchesThreads(item, settings)) threads = true;
    if (settings.count !== null) {
      counted = true;
      sum += settings.count;
    }
  }
  const reasons: RiskReason[] = [];
  if (chats > RISK_MAX_CHATS) reasons.push('many-chats');
  if (unbounded) reasons.push('unbounded');
  if (chats > 1 && sum > RISK_MAX_MESSAGES) reasons.push('many-messages');
  if (threads && chats > RISK_MAX_CHATS_WITH_THREADS) reasons.push('threads');
  return { risky: reasons.length > 0, reasons, chats, messageEstimate: counted ? sum : null };
}
