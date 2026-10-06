/** Discord tabs: finding them, recognising their URLs, focusing one or opening a new one. */
import { DISCORD_ORIGINS } from '@/shared';
import type { BgResponse } from '@/shared';
import { fail, ok } from './response';
import { describeError } from './util';

/** `chrome.tabs.query` URL filter for the three web client origins. */
export const DISCORD_TAB_PATTERNS: string[] = DISCORD_ORIGINS.map((origin) => `${origin}/*`);

/** Where `discord/open` goes when no Discord tab is open. */
export const DISCORD_HOME_URL = 'https://discord.com/channels/@me';

/** Is `url` a page of the Discord web client (exact origin match: `https://discord.com.evil.example` is not)? */
export function isDiscordUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return DISCORD_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/** All open Discord tabs (an empty list when the query fails). */
export async function queryDiscordTabs(): Promise<chrome.tabs.Tab[]> {
  try {
    return await chrome.tabs.query({ url: DISCORD_TAB_PATTERNS });
  } catch {
    return [];
  }
}

/** `discord/open`: bring an existing Discord tab to the front (preferring one that is already the visible tab of its window), or open Discord. */
export async function openDiscord(): Promise<BgResponse> {
  try {
    const tabs = await queryDiscordTabs();
    const target = tabs.find((tab) => tab.active && tab.id !== undefined) ?? tabs.find((tab) => tab.id !== undefined);
    if (target?.id !== undefined) {
      await chrome.tabs.update(target.id, { active: true });
      if (target.windowId !== undefined) await chrome.windows.update(target.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: DISCORD_HOME_URL });
    }
    return ok();
  } catch (error) {
    return fail('unknown', describeError(error));
  }
}
