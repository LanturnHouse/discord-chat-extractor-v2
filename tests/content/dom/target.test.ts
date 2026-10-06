// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { categoryRequest, buildTarget, minimalTarget } from '@/content/dom/target';
import { rowsWithin, type Row } from '@/content/dom/rows';
import { boot, type Booted } from '../helpers/app';
import { GUILD, ID, byKey, categoryRow, channelRow, dmRow, mount, setPage, sidebar, threadRow } from '../helpers/fixtures';

let ctx: Booted | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  setPage(`/channels/${GUILD}/${ID.general}`, '(1) Discord | #general | Server One');
});

afterEach(() => {
  ctx?.app.destroy();
  ctx = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const rowById = (id: string): Row => {
  const row = rowsWithin(document.body).find((r) => r.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

describe('the guild of a row without an href', () => {
  it('comes from the address bar', () => {
    mount(sidebar(channelRow({ id: ID.voice, name: 'lounge', voice: true })));
    expect(buildTarget(rowById(ID.voice))).toMatchObject({ guildId: GUILD, guildName: 'Server One' });
  });

  it('else from another row`s href in the same list (an address that is not a guild page)', () => {
    setPage('/channels/@me', 'Discord');
    mount(sidebar(channelRow({ id: ID.general, name: 'general' }), channelRow({ id: ID.voice, name: 'lounge', voice: true })));
    expect(buildTarget(rowById(ID.voice))).toMatchObject({ guildId: GUILD, guildName: null });
  });

  it('is null when nothing says (the background worker may still resolve the channel)', () => {
    setPage('/somewhere', 'Discord');
    mount(sidebar(channelRow({ id: ID.voice, name: 'lounge', voice: true })));
    expect(buildTarget(rowById(ID.voice))).toMatchObject({ guildId: null, guildName: null });
  });

  it('a category button without any guild information sends nothing and says so', async () => {
    setPage('/somewhere', 'Discord');
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })) });
    expect(categoryRequest(rowById(ID.categoryA))).toBeNull();
    byKey(ID.categoryA)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addCategory')).toEqual([]);
    expect(document.querySelector('[data-dce="toast"]')?.textContent).toBe('문제가 생겼어요. 잠시 후 다시 시도해 주세요');
  });
});

describe('the category of a channel', () => {
  it('is the nearest category row above it; a channel before the first category has none', () => {
    mount(
      sidebar(
        channelRow({ id: ID.forum, name: 'welcome' }),
        categoryRow({ id: ID.categoryA, name: 'Category A' }),
        channelRow({ id: ID.general, name: 'general' }),
        categoryRow({ id: ID.categoryB, name: 'Category B' }),
        channelRow({ id: ID.random, name: 'random' }),
      ),
    );
    expect(buildTarget(rowById(ID.forum))).not.toHaveProperty('parentId');
    expect(buildTarget(rowById(ID.general))).toMatchObject({ parentId: ID.categoryA, parentName: 'Category A' });
    expect(buildTarget(rowById(ID.random))).toMatchObject({ parentId: ID.categoryB, parentName: 'Category B' });
  });

  it('is never taken from another list (a category of a different section does not leak over)', () => {
    mount(
      `<div><ul>${categoryRow({ id: ID.categoryA, name: 'Category A' })}${channelRow({ id: ID.general, name: 'general' })}</ul></div>` +
        `<div><ul>${channelRow({ id: ID.random, name: 'random' })}</ul></div>`,
    );
    expect(buildTarget(rowById(ID.random))).not.toHaveProperty('parentId');
  });

  it('a nested layout (the channel li sits inside its category li) finds it too', () => {
    const category = categoryRow({ id: ID.categoryA, name: 'Category A' });
    const nested = category.replace('</li>', `<ul>${channelRow({ id: ID.general, name: 'general' })}</ul></li>`);
    mount(`<ul>${nested}</ul>`);
    expect(buildTarget(rowById(ID.general))).toMatchObject({ parentId: ID.categoryA, parentName: 'Category A' });
  });

  it('a thread`s parent is its channel, never a category', () => {
    mount(
      sidebar(
        categoryRow({ id: ID.categoryA, name: 'Category A' }),
        channelRow({ id: ID.general, name: 'general', threads: [threadRow({ id: ID.thread, name: 'Thread A' })] }),
      ),
    );
    expect(buildTarget(rowById(ID.thread))).toMatchObject({ kind: 'thread', parentId: ID.general, parentName: 'general' });
  });

  it('a category row is not a toggle target', () => {
    mount(sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })));
    expect(buildTarget(rowById(ID.categoryA))).toBeNull();
    expect(categoryRequest(rowById(ID.categoryA))).toEqual({
      guildId: GUILD,
      guildName: 'Server One',
      categoryId: ID.categoryA,
      categoryName: 'Category A',
    });
  });

  it('a channel row is not a category request', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general' })));
    expect(categoryRequest(rowById(ID.general))).toBeNull();
  });
});

describe('DM targets', () => {
  it('never carry a guild, even on a guild page address', () => {
    mount(dmRow({ id: ID.dm, name: 'Alex' }));
    expect(buildTarget(rowById(ID.dm))).toMatchObject({ kind: 'dm', guildId: null, guildName: null });
  });
});

describe('minimalTarget', () => {
  it('a guild chat: the names from the title when it names the chat', () => {
    expect(minimalTarget({ guildId: GUILD, channelId: ID.general })).toEqual({
      kind: 'guild-channel',
      channelId: ID.general,
      guildId: GUILD,
      guildName: 'Server One',
      channelName: 'general',
    });
  });

  it('a DM', () => {
    setPage(`/channels/@me/${ID.dm}`, 'Discord | @Alex');
    expect(minimalTarget({ guildId: null, channelId: ID.dm })).toEqual({
      kind: 'dm',
      channelId: ID.dm,
      guildId: null,
      guildName: null,
      channelName: 'Alex',
      iconUrl: null,
    });
  });

  it('the id stands in for the name when the title says nothing sure', () => {
    setPage(`/channels/${GUILD}/${ID.general}`, 'Discord');
    expect(minimalTarget({ guildId: GUILD, channelId: ID.general })).toMatchObject({ channelName: ID.general, guildName: null });
  });
});
