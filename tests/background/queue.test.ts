import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION, isApiGetPathAllowed } from '@/shared';
import type { QueueItem } from '@/shared';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  CATEGORY_ID,
  CHANNEL_A,
  CHANNEL_B,
  CHANNEL_C,
  DM_CHANNEL,
  GUILD_ID,
  OTHER_ACCOUNT_ID,
  OTHER_TOKEN,
  TOKEN,
  bootLoggedIn,
  bootWorker,
  dmTarget,
  exportSettings,
  guildTarget,
  installFakeDiscordApi,
  queueItem,
  seedGuildAccess,
  seedQueue,
  settle,
  storedQueue,
  userPayload,
  waitFor,
} from './helpers';
import type { FakeDiscordApi } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let content: FakePage;
let api: FakeDiscordApi;

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup, api } = await bootLoggedIn(fake));
  content = fake.createContentScript(7, 'https://discord.com/channels/200000000000000001/400000000000000001');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const toggle = (target: unknown, from: FakePage = content) => from.send({ to: 'bg', type: 'queue/toggle', target });
const keys = () => storedQueue(fake).map((item) => item.key);

describe('queue/toggle', () => {
  it('adds a chat that is not in the list: settings null (follows the common settings), addedAt now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await expect(toggle(guildTarget())).resolves.toEqual({ ok: true, data: { queued: true } });
    expect(storedQueue(fake)).toEqual([{ key: CHANNEL_A, target: guildTarget(), settings: null, addedAt: 1_760_000_000_000 }]);
  });

  it('removes a chat that is already in the list', async () => {
    await toggle(guildTarget());
    await expect(toggle(guildTarget())).resolves.toEqual({ ok: true, data: { queued: false } });
    expect(storedQueue(fake)).toEqual([]);
  });

  it('is a real toggle: add, remove, add', async () => {
    const states: boolean[] = [];
    for (let i = 0; i < 3; i += 1) states.push((await toggle(dmTarget())).data.queued);
    expect(states).toEqual([true, false, true]);
    expect(keys()).toEqual([DM_CHANNEL]);
  });

  it('keeps the other items and appends new ones at the end', async () => {
    await toggle(guildTarget(CHANNEL_A));
    await toggle(dmTarget());
    await toggle(guildTarget(CHANNEL_B));
    await toggle(dmTarget());
    expect(keys()).toEqual([CHANNEL_A, CHANNEL_B]);
  });

  it('works for the popup too, and for every chat kind', async () => {
    await toggle(guildTarget(CHANNEL_A, { kind: 'thread', parentId: CHANNEL_B, parentName: 'parent', channelType: 11 }), popup);
    await toggle(guildTarget(CHANNEL_C, { kind: 'forum', channelType: 15 }), popup);
    await toggle(dmTarget(DM_CHANNEL, { kind: 'group-dm' }), popup);
    expect(storedQueue(fake).map((item) => item.target.kind)).toEqual(['thread', 'forum', 'group-dm']);
  });

  it('stores only the known fields, with cleaned names', async () => {
    await toggle({ ...guildTarget(), channelName: ' gen‮eral ', extra: { x: 1 }, token: 'secret' });
    const [item] = storedQueue(fake);
    expect(item.target).toEqual(guildTarget());
    expect(JSON.stringify(item)).not.toContain('secret');
  });

  it.each([
    ['not an object', 'general'],
    ['no target', undefined],
    ['unknown kind', { ...guildTarget(), kind: 'voice' }],
    ['non-numeric channel id', { ...guildTarget(), channelId: 'general' }],
    ['numeric channel id as a number', { ...guildTarget(), channelId: 400000000000000001 }],
    ['non-numeric guild id', { ...guildTarget(), guildId: 'abc' }],
    ['a DM with a guild id', { ...dmTarget(), guildId: GUILD_ID }],
    ['a guild chat without a guild id', { ...guildTarget(), guildId: null }],
    ['a 101 character name', { ...guildTarget(), channelName: 'x'.repeat(101) }],
    ['a 101 character guild name', { ...guildTarget(), guildName: 'x'.repeat(101) }],
    ['an empty name', { ...guildTarget(), channelName: '' }],
  ])('refuses %s with "invalid" and writes nothing', async (_label, target) => {
    const response = await toggle(target);
    expect(response).toMatchObject({ ok: false, error: 'invalid' });
    expect(response.message).toEqual(expect.any(String));
    expect(fake.local.has(LOCAL.queue(ACCOUNT_ID))).toBe(false);
  });

  it('answers "no-account" while no account is verified, and changes nothing', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    const page = other.createContentScript(7, 'https://discord.com/channels/@me');
    await expect(toggle(guildTarget(), page)).resolves.toEqual({ ok: false, error: 'no-account' });
    expect(other.local.keys().filter((key) => key.startsWith('dce.queue.'))).toEqual([]);
  });

  it('a token that is stored but not verified (yet) is no account either', async () => {
    const other = createFakeBrowser();
    const otherApi = installFakeDiscordApi();
    otherApi.force = 'network';
    await bootWorker(other);
    other.captureToken(TOKEN);
    await waitFor(() => other.session.has(SESSION.token));
    const page = other.createContentScript(7, 'https://discord.com/channels/@me');
    await expect(toggle(guildTarget(), page)).resolves.toEqual({ ok: false, error: 'no-account' });
  });

  it('keeps a separate list per account', async () => {
    await toggle(guildTarget(CHANNEL_A));
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID));
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => (fake.session.peek(SESSION.account) as { id: string } | null)?.id === OTHER_ACCOUNT_ID);
    await toggle(guildTarget(CHANNEL_B));
    expect(storedQueue(fake, OTHER_ACCOUNT_ID).map((item) => item.key)).toEqual([CHANNEL_B]);
    expect(storedQueue(fake, ACCOUNT_ID).map((item) => item.key)).toEqual([CHANNEL_A]);
  });

  it('loses no update when many clicks arrive at once', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => String(400000000000000100n + BigInt(index)));
    await Promise.all(ids.map((id, index) => toggle(guildTarget(id, { channelName: `channel ${id}` }), index % 2 === 0 ? content : popup)));
    expect(new Set(keys())).toEqual(new Set(ids));
    expect(keys()).toHaveLength(30);
    // and an even number of clicks on one chat leaves it out
    await Promise.all(Array.from({ length: 10 }, () => toggle(dmTarget())));
    expect(keys()).not.toContain(DM_CHANNEL);
  });

  it('repairs a damaged stored list instead of failing', async () => {
    fake.local.seed({ [LOCAL.queue(ACCOUNT_ID)]: [{ key: 'nope' }, queueItem(guildTarget(CHANNEL_A)), 'junk'] });
    await expect(toggle(guildTarget(CHANNEL_B))).resolves.toMatchObject({ ok: true });
    expect(keys()).toEqual([CHANNEL_A, CHANNEL_B]);
  });
});

describe('queue/addCategory', () => {
  const channel = (id: string, type: number, name: string, extra: Record<string, unknown> = {}) => ({ id, type, name, parent_id: CATEGORY_ID, position: 0, ...extra });
  const guildChannels = [
    { id: CATEGORY_ID, type: 4, name: 'Study', parent_id: null, position: 0 },
    channel('400000000000000012', 0, 'second', { position: 2 }),
    channel('400000000000000011', 0, 'first', { position: 1 }),
    channel('400000000000000013', 5, 'announcements', { position: 3 }),
    channel('400000000000000014', 15, 'questions', { position: 4 }),
    channel('400000000000000015', 16, 'gallery', { position: 5 }),
    channel('400000000000000016', 2, 'voice room', { position: 6 }), // voice: not exportable
    channel('400000000000000017', 13, 'stage', { position: 7 }), // stage: not exportable
    channel('400000000000000018', 11, 'a thread', { position: 8 }), // threads are not listed under a category
    { id: '400000000000000019', type: 0, name: 'elsewhere', parent_id: '300000000000000099', position: 0 }, // another category
    { id: '400000000000000020', type: 0, name: 'no category', parent_id: null, position: 0 },
    { id: '400000000000000021', type: 0, name: 'same position b', parent_id: CATEGORY_ID, position: 9 },
    { id: '400000000000000010', type: 0, name: 'same position a', parent_id: CATEGORY_ID, position: 9 },
  ];
  const addCategory = (overrides: Record<string, unknown> = {}, from: FakePage = content) =>
    from.send({ to: 'bg', type: 'queue/addCategory', guildId: GUILD_ID, guildName: 'Test Server', categoryId: CATEGORY_ID, categoryName: 'Study', ...overrides });

  beforeEach(() => {
    api.guildChannels.set(GUILD_ID, guildChannels);
    seedGuildAccess(api); // a plain member who may read everything: the permission filter is on and keeps every channel
  });

  it('asks the guild for its channels with the stored authorization (allow-listed direct GET)', async () => {
    await addCategory();
    const call = api.calls.find((candidate) => candidate.url.includes('/channels'));
    expect(call).toMatchObject({ url: `https://discord.com/api/v9/guilds/${GUILD_ID}/channels`, method: 'GET', credentials: 'omit', headers: { Authorization: TOKEN } });
  });

  it('adds the exportable children of the category in the guild\'s order, with settings null', async () => {
    const response = await addCategory();
    expect(response).toEqual({ ok: true, data: { added: 7, skipped: 0, removed: 0 } });
    expect(storedQueue(fake).map((item) => item.target.channelName)).toEqual([
      'first',
      'second',
      'announcements',
      'questions',
      'gallery',
      'same position a', // equal positions: the smaller id first
      'same position b',
    ]);
    expect(storedQueue(fake).every((item) => item.settings === null)).toBe(true);
  });

  it('builds proper targets: forum for 15/16, channel type, parent = the category, guild name', async () => {
    await addCategory();
    const byName = Object.fromEntries(storedQueue(fake).map((item) => [item.target.channelName, item]));
    expect(byName.first).toMatchObject({
      key: '400000000000000011',
      settings: null,
      target: { kind: 'guild-channel', channelId: '400000000000000011', guildId: GUILD_ID, guildName: 'Test Server', channelName: 'first', parentId: CATEGORY_ID, parentName: 'Study', channelType: 0 },
    });
    expect(byName.announcements.target).toMatchObject({ kind: 'guild-channel', channelType: 5 });
    expect(byName.questions.target).toMatchObject({ kind: 'forum', channelType: 15 });
    expect(byName.gallery.target).toMatchObject({ kind: 'forum', channelType: 16 });
  });

  it('leaves out voice and stage channels, threads, other categories and channels without a category', async () => {
    await addCategory();
    const names = storedQueue(fake).map((item) => item.target.channelName);
    for (const excluded of ['voice room', 'stage', 'a thread', 'elsewhere', 'no category', 'Study']) expect(names).not.toContain(excluded);
  });

  it('orders by position and then by id', async () => {
    await addCategory();
    expect(keys()).toEqual([
      '400000000000000011',
      '400000000000000012',
      '400000000000000013',
      '400000000000000014',
      '400000000000000015',
      '400000000000000010',
      '400000000000000021',
    ]);
  });

  it('some of the children are in the list: only the missing ones are added, the others are skipped and keep their own settings', async () => {
    const own = queueItem(guildTarget('400000000000000012', { channelName: 'second' }), { settings: exportSettings({ format: 'csv' }), addedAt: 5, lastResult: { status: 'failed', message: 'x', at: 6 } });
    seedQueue(fake, [queueItem(dmTarget()), own]);
    const response = await addCategory();
    expect(response).toEqual({ ok: true, data: { added: 6, skipped: 1, removed: 0 } });
    expect(storedQueue(fake)[0].key).toBe(DM_CHANNEL);
    expect(storedQueue(fake)[1]).toEqual(own);
    expect(storedQueue(fake)).toHaveLength(8);
  });

  it('is a toggle: when every readable child is in the list, a second click takes exactly those out (the matrix is in groups.test.ts)', async () => {
    const own = queueItem(guildTarget('400000000000000012', { channelName: 'second' }), { settings: exportSettings({ format: 'csv' }), addedAt: 5 });
    seedQueue(fake, [queueItem(dmTarget()), own]);
    await addCategory(); // adds the other six
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 7 } });
    expect(keys()).toEqual([DM_CHANNEL]);
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 7, skipped: 0, removed: 0 } }); // and back in
  });

  it('works for the popup as well and reports nothing to add for an empty category', async () => {
    await expect(addCategory({ categoryId: '300000000000000077' }, popup)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(storedQueue(fake)).toEqual([]);
  });

  it('accepts a missing guild name (the target then has none)', async () => {
    await addCategory({ guildName: null });
    expect(storedQueue(fake)[0].target.guildName).toBeNull();
  });

  it('skips a child without a usable name and answers with what it could add', async () => {
    api.guildChannels.set(GUILD_ID, [channel('400000000000000031', 0, 'ok'), channel('400000000000000032', 0, '   '), { ...channel('400000000000000033', 0, 'x'), name: 5 }, { ...channel('abc', 0, 'bad id') }]);
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
    expect(keys()).toEqual(['400000000000000031']);
  });

  it('treats an answer that is not a list as an empty guild', async () => {
    api.guildChannels.set(GUILD_ID, { message: 'weird' });
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
  });

  it.each([
    ['guildId is not numeric', { guildId: 'abc' }],
    ['guildId is missing', { guildId: undefined }],
    ['categoryId is not numeric', { categoryId: 'study' }],
    ['guildName is a number', { guildName: 5 }],
    ['guildName is too long', { guildName: 'g'.repeat(101) }],
    ['categoryName is missing', { categoryName: undefined }],
    ['categoryName is too long', { categoryName: 'c'.repeat(101) }],
  ])('refuses the message when %s', async (_label, overrides) => {
    const calls = api.calls.length;
    const response = await addCategory(overrides);
    expect(response).toMatchObject({ ok: false, error: 'invalid' });
    expect(api.calls).toHaveLength(calls); // no request for a bad message
    expect(storedQueue(fake)).toEqual([]);
  });

  it('answers "no-account" without any request when there is no verified account', async () => {
    const other = createFakeBrowser();
    const otherApi = installFakeDiscordApi();
    await bootWorker(other);
    const page = other.createContentScript(7, 'https://discord.com/channels/@me');
    await expect(addCategory({}, page)).resolves.toEqual({ ok: false, error: 'no-account' });
    expect(otherApi.calls).toHaveLength(0);
  });

  it('maps a failed request to "http" and adds nothing', async () => {
    api.force = 403;
    await expect(addCategory()).resolves.toEqual({ ok: false, error: 'http', message: 'HTTP 403' });
    api.force = 'network';
    await expect(addCategory()).resolves.toEqual({ ok: false, error: 'http', message: 'network error' });
    api.force = null;
    api.guildChannels.delete(GUILD_ID);
    await expect(addCategory()).resolves.toEqual({ ok: false, error: 'http', message: 'HTTP 404' });
    expect(storedQueue(fake)).toEqual([]);
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN); // an ordinary failure does not touch the token
  });

  it('a 401 means the token is dead: it is removed (compare-and-clear) and the answer is "no-account"', async () => {
    api.users.delete(TOKEN); // Discord no longer knows it
    const response = await addCategory();
    expect(response).toEqual({ ok: false, error: 'no-account' });
    await waitFor(() => !fake.session.has(SESSION.token));
    await waitFor(() => fake.session.peek(SESSION.account) === null);
  });

  it('a guild that Discord does not know costs one request: the channel list. Nothing else is asked for', async () => {
    await addCategory({ guildId: '12345' });
    const paths = api.calls.map((call) => call.url.replace('https://discord.com', ''));
    expect(paths.filter((path) => path.includes('guilds'))).toEqual(['/api/v9/guilds/12345/channels']);
  });

  it('only ever requests allow-listed paths: the channel list, the roles, the guild and the own member', async () => {
    const before = api.calls.length;
    await addCategory();
    const calls = api.calls.slice(before);
    const paths = calls.map((call) => call.url.replace('https://discord.com', ''));
    expect(paths).toEqual([
      `/api/v9/guilds/${GUILD_ID}/channels`,
      `/api/v9/guilds/${GUILD_ID}/roles`,
      `/api/v9/guilds/${GUILD_ID}`,
      `/api/v9/users/@me/guilds/${GUILD_ID}/member`,
    ]);
    for (const path of paths) expect(isApiGetPathAllowed(path)).toBe(true);
    for (const call of calls) expect(call).toMatchObject({ method: 'GET', credentials: 'omit', headers: { Authorization: TOKEN, Accept: 'application/json' } });
  });

  it('a hidden channel is not added (the permission filter; its matrix is in guild.test.ts)', async () => {
    api.guildChannels.set(GUILD_ID, [
      ...guildChannels,
      { ...channel('400000000000000040', 0, 'hidden'), permission_overwrites: [{ id: GUILD_ID, type: 0, allow: '0', deny: String(1n << 10n) }] },
    ]);
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 7, skipped: 0, removed: 0 } });
    expect(storedQueue(fake).map((item) => item.target.channelName)).not.toContain('hidden');
  });
});

describe('queue/upsert (the popup\'s gear)', () => {
  const upsert = (item: unknown, from: FakePage = popup) => from.send({ to: 'bg', type: 'queue/upsert', item });

  it('replaces an item in place: own settings, same position, original addedAt', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A), { addedAt: 1 }), queueItem(guildTarget(CHANNEL_B), { addedAt: 2 }), queueItem(guildTarget(CHANNEL_C), { addedAt: 3 })]);
    const own = exportSettings({ count: 50, format: 'xlsx' });
    await expect(upsert(queueItem(guildTarget(CHANNEL_B), { settings: own, addedAt: 999 }))).resolves.toEqual({ ok: true });
    expect(keys()).toEqual([CHANNEL_A, CHANNEL_B, CHANNEL_C]);
    expect(storedQueue(fake)[1]).toEqual({ key: CHANNEL_B, target: guildTarget(CHANNEL_B), settings: own, addedAt: 2 });
  });

  it('settings null = back to the common settings', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A), { settings: exportSettings({ count: 5 }) })]);
    await upsert(queueItem(guildTarget(CHANNEL_A), { settings: null }));
    expect(storedQueue(fake)[0].settings).toBeNull();
  });

  it('keeps the stored lastResult unless the message says otherwise (explicit null clears it)', async () => {
    const lastResult = { status: 'failed' as const, message: 'forbidden', at: 5 };
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A), { lastResult })]);
    await upsert(queueItem(guildTarget(CHANNEL_A), { settings: exportSettings({ count: 9 }) }));
    expect(storedQueue(fake)[0].lastResult).toEqual(lastResult);
    await upsert(queueItem(guildTarget(CHANNEL_A), { lastResult: null }));
    expect(storedQueue(fake)[0].lastResult).toBeNull();
    await upsert(queueItem(guildTarget(CHANNEL_A), { lastResult: { status: 'partial', message: 'm', at: 8 } }));
    expect(storedQueue(fake)[0].lastResult).toEqual({ status: 'partial', message: 'm', at: 8 });
  });

  it('appends an item that is not in the list yet', async () => {
    await upsert(queueItem(dmTarget(), { settings: exportSettings({ format: 'md' }) }));
    expect(storedQueue(fake)).toHaveLength(1);
    expect(storedQueue(fake)[0].settings?.format).toBe('md');
  });

  it.each([
    ['a key that is not the channel id', { ...queueItem(guildTarget(CHANNEL_A)), key: CHANNEL_B }],
    ['settings that are incomplete', { ...queueItem(), settings: { count: 5 } }],
    ['settings with a count of 0', { ...queueItem(), settings: exportSettings({ count: 0 }) }],
    ['a range that ends before it starts', { ...queueItem(), settings: exportSettings({ from: '2026-12-31T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }) }],
    ['a target of an unknown kind', { ...queueItem(), target: { ...guildTarget(), kind: 'x' } }],
    ['no item', undefined],
    ['a string', 'item'],
  ])('refuses %s', async (_label, item) => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    await expect(upsert(item)).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(storedQueue(fake)).toEqual([queueItem(guildTarget(CHANNEL_A))]);
  });

  it('answers "no-account" without an account', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    await expect(upsert(queueItem(), other.createPage({ kind: 'popup' }))).resolves.toEqual({ ok: false, error: 'no-account' });
  });
});

describe('queue/remove and queue/clear', () => {
  const send = (message: Record<string, unknown>, from: FakePage = popup) => from.send({ to: 'bg', ...message });

  it('removes one item and leaves the rest', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B)), queueItem(guildTarget(CHANNEL_C))]);
    await expect(send({ type: 'queue/remove', key: CHANNEL_B })).resolves.toEqual({ ok: true });
    expect(keys()).toEqual([CHANNEL_A, CHANNEL_C]);
  });

  it('removing a chat that is not in the list is fine', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    await expect(send({ type: 'queue/remove', key: CHANNEL_B })).resolves.toEqual({ ok: true });
    expect(keys()).toEqual([CHANNEL_A]);
  });

  it.each([undefined, null, 5, 'abc', '', ['1']])('refuses the key %j', async (key) => {
    await expect(send({ type: 'queue/remove', key })).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });

  it('clears the whole list of the current account only', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B))]);
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_C))], OTHER_ACCOUNT_ID);
    await expect(send({ type: 'queue/clear' })).resolves.toEqual({ ok: true });
    expect(storedQueue(fake)).toEqual([]);
    expect(storedQueue(fake, OTHER_ACCOUNT_ID)).toHaveLength(1);
  });

  it('answers "no-account" for both without an account', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    const page = other.createPage({ kind: 'popup' });
    await expect(send({ type: 'queue/remove', key: CHANNEL_A }, page)).resolves.toEqual({ ok: false, error: 'no-account' });
    await expect(send({ type: 'queue/clear' }, page)).resolves.toEqual({ ok: false, error: 'no-account' });
  });
});

describe('when storage fails', () => {
  it('a change that cannot be stored is answered with "unknown" (no secret in the message), and the next one works', async () => {
    fake.local.set.mockRejectedValueOnce(new Error(`QUOTA_BYTES quota exceeded while storing ${TOKEN}`));
    const response = await toggle(guildTarget(CHANNEL_A));
    expect(response).toMatchObject({ ok: false, error: 'unknown' });
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(storedQueue(fake)).toEqual([]);
    await expect(toggle(guildTarget(CHANNEL_A))).resolves.toEqual({ ok: true, data: { queued: true } });
    expect(keys()).toEqual([CHANNEL_A]);
  });

  it('a read that fails does not leave the list locked either', async () => {
    fake.local.get.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(toggle(guildTarget(CHANNEL_A))).resolves.toMatchObject({ ok: false, error: 'unknown' });
    await expect(toggle(guildTarget(CHANNEL_A))).resolves.toMatchObject({ ok: true });
  });
});

describe('the list as the content script and the popup see it', () => {
  it('is announced through storage.onChanged: every change of the list reaches the listeners', async () => {
    const changes: string[] = [];
    fake.storageChanged.addListener((changed, area) => {
      if (area === 'local' && LOCAL.queue(ACCOUNT_ID) in changed) changes.push('queue');
    });
    await toggle(guildTarget());
    await settle();
    await toggle(guildTarget());
    await settle();
    expect(changes).toEqual(['queue', 'queue']);
  });

  it('writes nothing when nothing changed', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    fake.local.set.mockClear();
    await popup.send({ to: 'bg', type: 'queue/remove', key: CHANNEL_B });
    expect(fake.local.set).not.toHaveBeenCalled();
  });

  it('is typed as the contract says', async () => {
    await toggle(guildTarget());
    const item: QueueItem = storedQueue(fake)[0];
    expect(Object.keys(item).sort()).toEqual(['addedAt', 'key', 'settings', 'target']);
  });
});
