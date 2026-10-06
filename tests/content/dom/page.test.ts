// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  currentChannelNameFromTitle,
  currentGuildId,
  currentGuildName,
  parseChatPath,
  titleSegments,
} from '@/content/dom/page';

const docWithTitle = (title: string): Document => {
  document.title = title;
  return document;
};

describe('parseChatPath (shortcut)', () => {
  it('parses a guild chat, a DM and a jump link', () => {
    expect(parseChatPath('/channels/100000000000000001/200000000000000001')).toEqual({
      guildId: '100000000000000001',
      channelId: '200000000000000001',
    });
    expect(parseChatPath('/channels/@me/400000000000000001')).toEqual({ guildId: null, channelId: '400000000000000001' });
    expect(parseChatPath('/channels/100/200/300')).toEqual({ guildId: '100', channelId: '200' });
  });

  it('gives null where no chat is open', () => {
    for (const path of ['/channels/@me', '/channels/100', '/channels/100/channel-browser', '/guild-events', '/', '/store']) {
      expect(parseChatPath(path), path).toBeNull();
    }
  });
});

describe('current guild', () => {
  it('id comes from the address, only for numeric guilds', () => {
    expect(currentGuildId('/channels/100000000000000001/200000000000000001')).toBe('100000000000000001');
    expect(currentGuildId('/channels/100000000000000001')).toBe('100000000000000001');
    expect(currentGuildId('/channels/@me/400000000000000001')).toBeNull();
    expect(currentGuildId('/store')).toBeNull();
  });

  it('name is the last | segment of the tab title (PLAN §4)', () => {
    const path = '/channels/100000000000000001/200000000000000001';
    expect(currentGuildName(docWithTitle('(8) Discord | #general | Server One'), path)).toBe('Server One');
    expect(currentGuildName(docWithTitle('Discord | Server One'), path)).toBe('Server One');
    expect(currentGuildName(docWithTitle('Discord | Name | with | pipes'), path)).toBe('pipes');
  });

  it('is null outside a guild, with a one-part title, or when the last part names a chat', () => {
    expect(currentGuildName(docWithTitle('Discord | @Alex'), '/channels/@me/400000000000000001')).toBeNull();
    expect(currentGuildName(docWithTitle('Discord'), '/channels/100000000000000001/2')).toBeNull();
    expect(currentGuildName(docWithTitle('Discord | @Alex'), '/channels/100000000000000001/2')).toBeNull();
    expect(currentGuildName(docWithTitle('Discord | #general'), '/channels/100000000000000001/2')).toBeNull();
    expect(currentGuildName(docWithTitle(''), '/channels/100000000000000001/2')).toBeNull();
  });

  it('splits titles into trimmed non-empty segments', () => {
    expect(titleSegments('  (8)  Discord |  #general  |   Server ')).toEqual(['(8) Discord', '#general', 'Server']);
    expect(titleSegments('')).toEqual([]);
  });
});

describe('channel name from the title', () => {
  it('only for the two unambiguous shapes', () => {
    expect(currentChannelNameFromTitle(docWithTitle('Discord | #general | Server One'))).toBe('general');
    expect(currentChannelNameFromTitle(docWithTitle('Discord | @Alex'))).toBe('Alex');
  });

  it('gives null rather than the name of the wrong chat (thread titles have one more segment)', () => {
    expect(currentChannelNameFromTitle(docWithTitle('Discord | Thread title | #general | Server One'))).toBeNull();
    expect(currentChannelNameFromTitle(docWithTitle('Discord | Server One'))).toBeNull();
    expect(currentChannelNameFromTitle(docWithTitle('Discord'))).toBeNull();
    expect(currentChannelNameFromTitle(docWithTitle('Discord | # | Server'))).toBeNull();
  });
});
