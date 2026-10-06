import { describe, expect, it } from 'vitest';
import { guildItemId, listItemTailId, parseChannelHref, parseChannelPath } from '@/content/dom/ids';

describe('parseChannelPath', () => {
  it('reads guild and DM channel paths', () => {
    expect(parseChannelPath('/channels/100000000000000001/200000000000000001')).toEqual({
      guildId: '100000000000000001',
      channelId: '200000000000000001',
    });
    expect(parseChannelPath('/channels/@me/400000000000000001')).toEqual({ guildId: '@me', channelId: '400000000000000001' });
  });

  it('rejects everything else', () => {
    for (const path of [
      '/channels/@me',
      '/channels/100/200/300',
      '/channels/abc/200',
      '/channels/100/channel-browser',
      '/channels/@me/',
      '/store',
      '',
    ]) {
      expect(parseChannelPath(path), path).toBeNull();
    }
  });
});

describe('parseChannelHref', () => {
  it('accepts relative and absolute hrefs and ignores query and fragment', () => {
    expect(parseChannelHref('/channels/1/2')).toEqual({ guildId: '1', channelId: '2' });
    expect(parseChannelHref('https://discord.com/channels/@me/3')).toEqual({ guildId: '@me', channelId: '3' });
    expect(parseChannelHref('/channels/1/2?x=1#y')).toEqual({ guildId: '1', channelId: '2' });
  });

  it('gives null for missing, malformed or foreign paths', () => {
    expect(parseChannelHref(null)).toBeNull();
    expect(parseChannelHref(undefined)).toBeNull();
    expect(parseChannelHref('')).toBeNull();
    expect(parseChannelHref('/store')).toBeNull();
    expect(parseChannelHref('http://[bad')).toBeNull();
  });
});

describe('list item ids', () => {
  it('takes the numeric tail of a DM item id (the uid_<n> part is a list position, not an id)', () => {
    expect(listItemTailId('private-channels-uid_11___400000000000000001')).toBe('400000000000000001');
    expect(listItemTailId('private-channels-uid_11___friends')).toBeNull();
    expect(listItemTailId('channels___channels-100000000000000001')).toBeNull();
    expect(listItemTailId(null)).toBeNull();
    expect(listItemTailId('')).toBeNull();
  });

  it('guild list items are channels___<digits> only', () => {
    expect(guildItemId('channels___200000000000000001')).toBe('200000000000000001');
    expect(guildItemId('channels___channels-100000000000000001')).toBeNull();
    expect(guildItemId('channels___guild-events')).toBeNull();
    expect(guildItemId('private-channels-uid_11___400000000000000001')).toBeNull();
    expect(guildItemId(undefined)).toBeNull();
  });
});
