/**
 * The download list ("queue") of the CURRENT account: `LOCAL.queue(accountId)`, written only here (and by the job bookkeeping in
 * store.ts). The content script's buttons send `queue/toggle` (a row), `queue/addCategory` (a category) and `queue/addGuild` (the
 * server header), and `queue/groupInfo` when a server comes into view; the popup sends `upsert` / `remove` / `removeMany` /
 * `clear` and, for the gear on a server or category row, `setGroupSettings` (5th change: group settings in
 * `LOCAL.groupSettings(accountId)` that the channels below follow, item > category > server > common). Every incoming object is
 * validated strictly (validate.ts); with no verified account every operation answers `{ ok: false, error: 'no-account' }`.
 *
 * Group settings never outlive the last queued channel of their group: every write that takes an item out of the list
 * (`remove`, `removeMany`, `clear`, a toggle, a category or server button that removes, a finished item: store.ts) prunes them
 * in the same storage write (`mutateQueueState`), and so does every re-record of a guild's groups (groups.ts: a channel that
 * moved to another category leaves its old category without a queued channel).
 *
 * The category and server buttons are toggles over a group of channels (docs/PLAN.md §2): the group is the channels of the guild
 * (or of the category) that the account may read. Every one of them already in the list: they all leave it. Otherwise the missing
 * ones are added. Every operation that loads a guild also records its groups in `LOCAL.groups` (groups.ts).
 */
import { belongsToGroup, categoryIdOf, pruneGroupSettings } from '@/shared';
import type { AccountInfo, BgResponse, ExportSettings, QueueItem } from '@/shared';
import type { GuildChannel } from './guild';
import { loadGuildWithGroups } from './groups';
import { fail, invalid, ok } from './response';
import { mutateQueue, mutateQueueState, readAccount, readToken } from './store';
import { isNumericId } from './util';
import { MAX_NAME_LENGTH, cleanText, validateGroupSettingsRequest, validateKeyList, validateQueueItem, validateTarget } from './validate';
import type { Checked } from './validate';

/** What a category or server click did. Exactly one of `removed` and `added` is above zero, unless the group was empty. */
export interface GroupToggleResult {
  /** Channels put into the list. */
  added: number;
  /** Readable channels of the group that were already in the list when the missing ones were added. */
  skipped: number;
  /** Channels taken out of the list: every readable channel of the group, when all of them were in. */
  removed: number;
}

/** `queue/toggle`: the chat is in the list -> remove it; it is not -> add it with `settings: null` (follows the common settings). */
export async function toggleQueue(rawTarget: unknown): Promise<BgResponse<{ queued: boolean }>> {
  const target = validateTarget(rawTarget);
  if (!target.ok) return invalid(target.message);
  const account = await readAccount();
  if (account === null) return fail('no-account');

  const queued = await mutateQueue(account.id, (items) => {
    const index = items.findIndex((item) => item.key === target.value.channelId);
    if (index >= 0) {
      items.splice(index, 1);
      return false;
    }
    items.push({ key: target.value.channelId, target: target.value, settings: null, addedAt: Date.now() });
    return true;
  });
  return ok({ queued });
}

/**
 * The toggle of a group, in ONE step under the storage lock (the decision and the change see the same list):
 *  - no channel: nothing happens (all zeros);
 *  - every channel is in the list: exactly those items leave it (whatever their settings), nothing else is touched;
 *  - otherwise the channels that are not in the list yet go to the end, in order, with `settings: null` (they follow the
 *    common settings); the ones that are in already are left alone and counted as `skipped`.
 */
function toggleChannels(
  accountId: string,
  guildId: string,
  guildName: string | null,
  channels: readonly GuildChannel[],
): Promise<GroupToggleResult> {
  const now = Date.now();
  return mutateQueue(accountId, (items): GroupToggleResult => {
    if (channels.length === 0) return { added: 0, skipped: 0, removed: 0 };

    const queued = new Set(items.map((item) => item.key));
    if (channels.every((channel) => queued.has(channel.id))) {
      const leaving = new Set(channels.map((channel) => channel.id));
      let removed = 0;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (!leaving.has(items[index].key)) continue;
        items.splice(index, 1);
        removed += 1;
      }
      return { added: 0, skipped: 0, removed };
    }

    let added = 0;
    let skipped = 0;
    for (const channel of channels) {
      if (queued.has(channel.id)) {
        skipped += 1;
        continue;
      }
      const target = validateTarget({
        kind: channel.kind,
        channelId: channel.id,
        guildId,
        guildName,
        channelName: channel.name,
        parentId: channel.parentId,
        parentName: channel.parentName,
        channelType: channel.type,
      });
      if (!target.ok) continue; // a channel without a usable name: nothing to put in the list
      items.push({ key: channel.id, target: target.value, settings: null, addedAt: now });
      queued.add(channel.id);
      added += 1;
    }
    return { added, skipped, removed: 0 };
  });
}

/** A guild named by a message: the id, and the name the page knows (null when it does not, or when it is empty once cleaned). */
function validateGuildRef(raw: Record<string, unknown>): Checked<{ guildId: string; guildName: string | null }> {
  const { guildId, guildName } = raw;
  if (!isNumericId(guildId)) return { ok: false, message: 'guildId must be a numeric string' };
  const label = guildName === null ? '' : cleanText(guildName, MAX_NAME_LENGTH);
  if (label === null) return { ok: false, message: 'guildName must be null or at most 100 characters' };
  return { ok: true, value: { guildId, guildName: label === '' ? null : label } };
}

/** The current account and its authorization, or null while either is missing (no verified account). */
async function readSession(): Promise<{ account: AccountInfo; token: string } | null> {
  const account = await readAccount();
  const token = await readToken();
  return account === null || token === null ? null : { account, token };
}

/**
 * `queue/addCategory` (#13), a toggle: the group is every channel of the category (`parent_id` match; type 0/5/15/16) that the
 * account may read (VIEW_CHANNEL and READ_MESSAGE_HISTORY, see guild.ts), in the guild's order. All of them in the list: they
 * are removed (`{ added: 0, skipped: 0, removed }`). Otherwise the missing ones are added with `settings: null`
 * (`{ added, skipped, removed: 0 }`, `skipped` = the readable children that were already there). An empty group changes nothing.
 * The groups of the whole guild are recorded on the way.
 */
export async function addCategory(raw: Record<string, unknown>): Promise<BgResponse<GroupToggleResult>> {
  const guild = validateGuildRef(raw);
  if (!guild.ok) return invalid(guild.message);
  const { categoryId, categoryName } = raw;
  if (!isNumericId(categoryId)) return invalid('categoryId must be a numeric string');
  const categoryLabel = cleanText(categoryName, MAX_NAME_LENGTH);
  if (categoryLabel === null) return invalid('categoryName must be at most 100 characters');

  const session = await readSession();
  if (session === null) return fail('no-account');

  const loaded = await loadGuildWithGroups(session.account, session.token, guild.value.guildId, false, guild.value.guildName);
  if (!loaded.ok) return loaded.response;

  const parentName = categoryLabel === '' ? null : categoryLabel;
  const children = loaded.value.channels.filter((channel) => channel.parentId === categoryId).map((channel) => ({ ...channel, parentName }));
  return ok(await toggleChannels(session.account.id, guild.value.guildId, guild.value.guildName, children));
}

/**
 * `queue/addGuild` (the server button), a toggle: the group is every channel of the guild (type 0/5/15/16) that the account may
 * read, in the order of Discord's sidebar (channels without a category first, then category by category). All of them in the
 * list: they are removed. Otherwise the missing ones are added with `settings: null`, in that order (counts as for the category
 * button). The guild name comes from the message, else from the guild itself. The groups of the guild are recorded on the way.
 */
export async function addGuild(raw: Record<string, unknown>): Promise<BgResponse<GroupToggleResult>> {
  const guild = validateGuildRef(raw);
  if (!guild.ok) return invalid(guild.message);

  const session = await readSession();
  if (session === null) return fail('no-account');

  const loaded = await loadGuildWithGroups(session.account, session.token, guild.value.guildId, false, guild.value.guildName);
  if (!loaded.ok) return loaded.response;

  return ok(await toggleChannels(session.account.id, guild.value.guildId, guild.value.guildName ?? loaded.value.guildName, loaded.value.channels));
}

/**
 * `queue/groupInfo`: the content script has a server in view and wants the check state of its category and server buttons. The
 * guild is loaded through the cache (or the load that is running is joined) and its groups are written to `LOCAL.groups`; the
 * answer carries no data, the content script reads the storage. The queue is not touched.
 */
export async function groupInfo(raw: Record<string, unknown>): Promise<BgResponse> {
  const guild = validateGuildRef(raw);
  if (!guild.ok) return invalid(guild.message);

  const session = await readSession();
  if (session === null) return fail('no-account');

  const loaded = await loadGuildWithGroups(session.account, session.token, guild.value.guildId, true, guild.value.guildName);
  return loaded.ok ? ok() : loaded.response;
}

/**
 * `queue/upsert` (the popup's gear): replaces the item with the same key in place (or appends it). `settings: null` = back to
 * the common settings. The stored `addedAt` is kept, and so is the stored `lastResult` unless the message carries one.
 */
export async function upsertQueueItem(rawItem: unknown): Promise<BgResponse> {
  const checked = validateQueueItem(rawItem);
  if (!checked.ok) return invalid(checked.message);
  const account = await readAccount();
  if (account === null) return fail('no-account');

  const incoming = checked.value;
  await mutateQueue(account.id, (items) => {
    const index = items.findIndex((item) => item.key === incoming.key);
    if (index < 0) {
      items.push(incoming);
      return;
    }
    const stored = items[index];
    const next: QueueItem = { ...incoming, addedAt: stored.addedAt };
    if (incoming.lastResult === undefined && stored.lastResult) next.lastResult = stored.lastResult;
    items[index] = next;
  });
  return ok();
}

/**
 * `queue/setGroupSettings` (the popup's gear on a server or category row, 5th change, docs/PLAN.md §2, §7.2a): the settings of a
 * group, applied to everything below it at once. The group's channels are the queue items for which `belongsToGroup` holds
 * (src/shared/groups.ts: a server's items, or a category's items by the recorded groups and the target's `parentId`).
 *
 *  - `settings` given: stored as `groupSettings[groupId]`. Every item below that has settings of its own gets `settings: null`
 *    again (it follows the group now), and for a server the settings of the categories of that server go too (their channels
 *    follow the server now). Answer `{ cleared }` = overrides cleared + category settings deleted. A group without any queued
 *    channel is refused with `empty` (settings of a group nobody is in would be pruned at once, and must not outlive its channels).
 *  - `settings: null`: takes only the group's own settings away; the settings the items and sub-categories have stay. `{ cleared: 0 }`.
 *
 * Queue, group settings and the pruning of `pruneGroupSettings` are ONE read-modify-write under the storage lock and ONE storage
 * write: no other writer of the queue (a toggle, a finished item, a second message of this kind) can see or produce a mixture.
 */
export async function setGroupSettings(raw: Record<string, unknown>): Promise<BgResponse<{ cleared: number }>> {
  const request = validateGroupSettingsRequest(raw);
  if (!request.ok) return invalid(request.message);
  const account = await readAccount();
  if (account === null) return fail('no-account');
  const { kind, guildId, groupId, settings } = request.value;

  const outcome = await mutateQueueState(account.id, (state): { cleared: number } | 'empty' => {
    const below = state.items.filter((item) => belongsToGroup(item, kind, groupId, state.groups));
    if (settings === null) {
      delete state.groupSettings[groupId];
      state.groupSettings = pruneGroupSettings(state.groupSettings, state.items, state.groups) as Record<string, ExportSettings>;
      return { cleared: 0 };
    }
    if (below.length === 0) return 'empty';

    let cleared = 0;
    for (const item of below) {
      if (item.settings === null) continue;
      item.settings = null;
      cleared += 1;
    }
    if (kind === 'guild') {
      // the categories of the server: the recorded ones, and the ones the items below say they sit in (their group may not be recorded)
      const categories = new Set<string>();
      for (const [id, group] of Object.entries(state.groups)) if (group.kind === 'category' && group.guildId === guildId) categories.add(id);
      for (const item of below) {
        const category = categoryIdOf(item, state.groups);
        if (category !== null) categories.add(category);
      }
      for (const id of categories) {
        if (!(id in state.groupSettings)) continue;
        delete state.groupSettings[id];
        cleared += 1;
      }
    }
    state.groupSettings[groupId] = settings;
    state.groupSettings = pruneGroupSettings(state.groupSettings, state.items, state.groups) as Record<string, ExportSettings>;
    return { cleared };
  });
  return outcome === 'empty' ? fail('empty') : ok(outcome);
}

/** `queue/remove`: idempotent (a key that is not in the list is fine). The settings of a group it was the last item of go with it. */
export async function removeQueueItem(key: unknown): Promise<BgResponse> {
  if (!isNumericId(key)) return invalid('key must be a numeric string');
  const account = await readAccount();
  if (account === null) return fail('no-account');
  await mutateQueue(account.id, (items) => {
    const index = items.findIndex((item) => item.key === key);
    if (index >= 0) items.splice(index, 1);
  });
  return ok();
}

/**
 * `queue/removeMany` (the popup's ✕ on a group row): takes every listed channel out of the list in one step. Keys that are not in
 * the list are ignored; `removed` is the number of items that really left. The settings of groups that have no item left go too.
 */
export async function removeMany(rawKeys: unknown): Promise<BgResponse<{ removed: number }>> {
  const keys = validateKeyList(rawKeys);
  if (!keys.ok) return invalid(keys.message);
  const account = await readAccount();
  if (account === null) return fail('no-account');
  const leaving = new Set(keys.value);
  const removed = await mutateQueue(account.id, (items) => {
    let count = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (!leaving.has(items[index].key)) continue;
      items.splice(index, 1);
      count += 1;
    }
    return count;
  });
  return ok({ removed });
}

/** `queue/clear`: the list is emptied and every group setting of the account goes with it (a group without items has no settings). */
export async function clearQueue(): Promise<BgResponse> {
  const account = await readAccount();
  if (account === null) return fail('no-account');
  await mutateQueueState(account.id, (state) => {
    state.items.length = 0;
    state.groupSettings = {};
  });
  return ok();
}
