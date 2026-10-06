/** Keyboard shortcut (#15, docs/PLAN.md §7.1): `add-current-chat` toggles the chat the user is looking at. */
import type { ToContent } from '@/shared';
import { isDiscordUrl } from './tabs';

export const ADD_CURRENT_CHAT_COMMAND = 'add-current-chat';

/**
 * `chrome.commands.onCommand`: when the active tab is a Discord tab, ask its content script to toggle the current chat (it
 * knows the channel and shows the toast). Anything else (another command, another site, no content script there) is ignored.
 */
export async function handleCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  if (command !== ADD_CURRENT_CHAT_COMMAND) return;
  let target = tab !== undefined && tab.id !== undefined && isDiscordUrl(tab.url) ? tab : undefined;
  if (target === undefined) {
    try {
      target = (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find((candidate) => isDiscordUrl(candidate.url));
    } catch {
      return;
    }
  }
  if (target?.id === undefined) return;
  const message: ToContent = { to: 'content', type: 'shortcut/toggleCurrent' };
  try {
    await chrome.tabs.sendMessage(target.id, message);
  } catch {
    // the tab has no content script (opened before the extension was installed, or not finished loading)
  }
}
