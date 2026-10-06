/** The `add-current-chat` keyboard shortcut (docs/PLAN.md §7.1, #15): the background worker sends `shortcut/toggleCurrent`. */
import type { Actions } from './actions';
import { buildTarget, minimalTarget } from './dom/target';
import { parseChatPath } from './dom/page';
import { findRowById } from './dom/rows';
import type { Strings } from './i18n';
import type { Toast } from './ui/toast';

export interface ShortcutDeps {
  doc: Document;
  /** `location.pathname` (a function, so a test can steer it). */
  pathname(): string;
  actions: Actions;
  toast: Toast;
  strings(): Strings;
}

/**
 * Toggles the chat in the address bar (`/channels/<guildId>/<channelId>` or `/channels/@me/<channelId>`): the target comes
 * from the matching sidebar row when it is on screen (real names, avatar, category), else from the address and the tab
 * title alone. The result is shown as a toast like a click.
 */
export async function toggleCurrentChat(deps: ShortcutDeps): Promise<void> {
  const chat = parseChatPath(deps.pathname());
  if (!chat) {
    deps.toast.show('info', deps.strings().toastNoChat);
    return;
  }
  const row = findRowById(deps.doc, chat.channelId);
  const fromRow = row ? buildTarget(row) : null;
  await deps.actions.toggle(fromRow ?? minimalTarget(chat));
}
