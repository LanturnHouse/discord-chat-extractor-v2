/**
 * What a click (or the keyboard shortcut) does: send `queue/toggle`, `queue/addCategory` or `queue/addGuild` to the background
 * worker, update the icons from the answer at once, and tell the user with a toast (docs/PLAN.md §7.1). The content script
 * never decides anything about the queue itself: the background worker owns it, `storage.onChanged` confirms it.
 *
 * The category and server buttons are toggles too (PLAN §2 "추가 UX 규칙"): when every channel of the group is in the list the
 * worker removes them all (`removed`), otherwise it adds the missing ones (`added`).
 */
import type { BgError, ToBackground } from '@/shared/messages';
import type { ChatTarget } from '@/shared/types';
import type { CategoryRequest, GuildRequest } from './dom/target';
import type { Strings } from './i18n';
import { sendToBackground } from './platform';
import type { ContentStore } from './state';
import type { Toast, ToastKind } from './ui/toast';

export type ActionOutcome =
  | 'added'
  | 'removed'
  | 'category-added'
  | 'category-removed'
  | 'category-nothing'
  | 'guild-added'
  | 'guild-removed'
  | 'guild-nothing'
  | 'failed'
  | 'dead';

/** What an "all channels of a group" button works on: a category or a whole server (only `empty` reads differently). */
export type AddScope = 'category' | 'guild';

export interface ActionDeps {
  store: ContentStore;
  toast: Toast;
  strings(): Strings;
  isAlive(): boolean;
  /** The extension context is gone: the owner tears everything down. */
  onDead(): void;
}

/** The toast for an error answer. A missing account is not a failure of the user's, so it is an info toast. */
export function errorToast(
  strings: Strings,
  error: BgError | 'offline',
  scope: AddScope = 'category',
): { kind: ToastKind; text: string } {
  switch (error) {
    case 'no-account':
      return { kind: 'info', text: strings.toastNoAccount };
    case 'no-consent':
      return { kind: 'info', text: strings.toastNoConsent };
    case 'busy':
      return { kind: 'info', text: strings.toastBusy };
    case 'empty':
      return { kind: 'info', text: scope === 'guild' ? strings.toastEmptyGuild : strings.toastEmpty };
    case 'http':
      return { kind: 'error', text: strings.toastHttp };
    case 'offline':
      return { kind: 'error', text: strings.toastOffline };
    default:
      return { kind: 'error', text: strings.toastError };
  }
}

/** A count from the worker's answer: a finite number of at least 0, else 0 (an older worker has no `removed`). */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export class Actions {
  constructor(private readonly deps: ActionDeps) {}

  private fail(error: BgError | 'offline', scope: AddScope = 'category'): 'failed' {
    const { kind, text } = errorToast(this.deps.strings(), error, scope);
    this.deps.toast.show(kind, text);
    return 'failed';
  }

  /** Adds the chat to the download list, or removes it when it is already there. */
  async toggle(target: ChatTarget): Promise<ActionOutcome> {
    const response = await sendToBackground<{ queued: boolean }>({ to: 'bg', type: 'queue/toggle', target });
    if (!this.deps.isAlive()) {
      this.deps.onDead();
      return 'dead';
    }
    if (!response) return this.fail('offline');
    if (!response.ok) return this.fail(response.error);
    const queued = response.data?.queued;
    if (typeof queued !== 'boolean') return this.fail('unknown');
    this.deps.store.setQueued(target.channelId, queued);
    const strings = this.deps.strings();
    this.deps.toast.show('success', queued ? strings.toastAdded : strings.toastRemoved);
    return queued ? 'added' : 'removed';
  }

  /** Category button: adds the channels that are not in the list yet, or removes them all when every one is already there. */
  addCategory(request: CategoryRequest): Promise<ActionOutcome> {
    return this.toggleGroup('category', request.categoryId, {
      to: 'bg',
      type: 'queue/addCategory',
      guildId: request.guildId,
      guildName: request.guildName,
      categoryId: request.categoryId,
      categoryName: request.categoryName,
    });
  }

  /** Server button: the same for every channel of the server (the worker filters by permission). */
  addGuild(request: GuildRequest): Promise<ActionOutcome> {
    return this.toggleGroup('guild', request.guildId, {
      to: 'bg',
      type: 'queue/addGuild',
      guildId: request.guildId,
      guildName: request.guildName,
    });
  }

  /**
   * One request of a group button. The answer says what happened: `removed > 0` = every channel was in the list and has been
   * taken out (the button is unchecked now), `added > 0` = the missing ones were added (every channel is in: checked now), both 0
   * = there was nothing to do. The icon follows the answer at once; the storage events confirm it a moment later.
   */
  private async toggleGroup(scope: AddScope, groupId: string, message: ToBackground): Promise<ActionOutcome> {
    const response = await sendToBackground<{ added: number; skipped: number; removed?: number }>(message);
    if (!this.deps.isAlive()) {
      this.deps.onDead();
      return 'dead';
    }
    if (!response) return this.fail('offline', scope);
    if (!response.ok) return this.fail(response.error, scope);
    const raw = response.data?.added;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return this.fail('unknown', scope);
    const added = countOf(raw);
    const removed = countOf(response.data?.removed);
    const strings = this.deps.strings();
    if (removed > 0) {
      this.deps.store.setGroupChecked(groupId, false);
      this.deps.toast.show('success', strings.toastCategoryRemoved(removed));
      return scope === 'guild' ? 'guild-removed' : 'category-removed';
    }
    if (added > 0) {
      this.deps.store.setGroupChecked(groupId, true);
      this.deps.toast.show('success', strings.toastCategoryAdded(added));
      return scope === 'guild' ? 'guild-added' : 'category-added';
    }
    this.deps.toast.show('info', scope === 'guild' ? strings.toastGuildNothing : strings.toastCategoryNothing);
    return scope === 'guild' ? 'guild-nothing' : 'category-nothing';
  }
}
