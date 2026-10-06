import { describe, expect, it } from 'vitest';
import { avatarUrl, channelIconUrl, defaultAvatarUrl, emojiUrl, guildIconUrl, stickerUrl } from '@/lib/discord/cdn';
import { CDN_BASE, MEDIA_BASE } from '@/lib/discord/constants';

const USER_ID = '80351110224678912';

describe('defaultAvatarUrl', () => {
  it('uses (id >> 22) % 6 for migrated usernames (discriminator "0" or missing)', () => {
    const expected = Number((BigInt(USER_ID) >> 22n) % 6n);
    expect(defaultAvatarUrl(USER_ID)).toBe(`${CDN_BASE}/embed/avatars/${expected}.png`);
    expect(defaultAvatarUrl(USER_ID, '0')).toBe(`${CDN_BASE}/embed/avatars/${expected}.png`);
  });

  it('uses discriminator % 5 for legacy accounts', () => {
    expect(defaultAvatarUrl(USER_ID, '1234')).toBe(`${CDN_BASE}/embed/avatars/4.png`);
    expect(defaultAvatarUrl(USER_ID, '0005')).toBe(`${CDN_BASE}/embed/avatars/0.png`);
  });

  it('falls back to the new scheme for a garbage discriminator', () => {
    const expected = Number((BigInt(USER_ID) >> 22n) % 6n);
    expect(defaultAvatarUrl(USER_ID, 'abcd')).toBe(`${CDN_BASE}/embed/avatars/${expected}.png`);
  });

  it('always picks an index between 0 and 5', () => {
    for (let i = 0; i < 50; i++) {
      const id = (BigInt(USER_ID) + BigInt(i) * 4194304n).toString();
      expect(defaultAvatarUrl(id)).toMatch(/\/embed\/avatars\/[0-5]\.png$/);
    }
  });
});

describe('avatarUrl', () => {
  it('builds a static png url with the requested size (default 80)', () => {
    expect(avatarUrl({ id: USER_ID, avatar: 'a_abc123' })).toBe(`${CDN_BASE}/avatars/${USER_ID}/a_abc123.png?size=80`);
    expect(avatarUrl({ id: USER_ID, avatar: 'abc123' }, 32)).toBe(`${CDN_BASE}/avatars/${USER_ID}/abc123.png?size=32`);
  });

  it('falls back to the default avatar without a hash', () => {
    expect(avatarUrl({ id: USER_ID, avatar: null })).toBe(defaultAvatarUrl(USER_ID));
    expect(avatarUrl({ id: USER_ID, discriminator: '1234' })).toBe(defaultAvatarUrl(USER_ID, '1234'));
  });

  it('passes through data: and https: values (used by the demo client)', () => {
    expect(avatarUrl({ id: USER_ID, avatar: 'data:image/svg+xml;base64,AAAA' })).toBe('data:image/svg+xml;base64,AAAA');
    expect(avatarUrl({ id: USER_ID, avatar: 'https://example.test/a.png' })).toBe('https://example.test/a.png');
  });

  it('never passes through other schemes: the result stays on the CDN', () => {
    expect(avatarUrl({ id: USER_ID, avatar: 'javascript:alert(1)' }).startsWith(`${CDN_BASE}/avatars/`)).toBe(true);
  });
});

describe('guildIconUrl', () => {
  it('builds the icon url (default size 96)', () => {
    expect(guildIconUrl('123', 'hash')).toBe(`${CDN_BASE}/icons/123/hash.png?size=96`);
    expect(guildIconUrl('123', 'a_hash', 128)).toBe(`${CDN_BASE}/icons/123/a_hash.png?size=128`);
  });

  it('is null without a hash', () => {
    expect(guildIconUrl('123', null)).toBeNull();
    expect(guildIconUrl('123', undefined)).toBeNull();
    expect(guildIconUrl('123', '')).toBeNull();
  });

  it('passes through data: / https: values', () => {
    expect(guildIconUrl('123', 'data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    expect(guildIconUrl('123', 'https://example.test/i.png')).toBe('https://example.test/i.png');
  });
});

describe('channelIconUrl', () => {
  it('builds the group icon url (default size 80) or null', () => {
    expect(channelIconUrl('55', 'h')).toBe(`${CDN_BASE}/channel-icons/55/h.png?size=80`);
    expect(channelIconUrl('55', 'h', 40)).toBe(`${CDN_BASE}/channel-icons/55/h.png?size=40`);
    expect(channelIconUrl('55', null)).toBeNull();
    expect(channelIconUrl('55', undefined)).toBeNull();
  });

  it('passes through data: / https: values', () => {
    expect(channelIconUrl('55', 'https://example.test/g.png')).toBe('https://example.test/g.png');
  });
});

describe('emojiUrl', () => {
  it('requests static emoji as png', () => {
    expect(emojiUrl('99', false)).toBe(`${CDN_BASE}/emojis/99.png?size=44`);
    expect(emojiUrl('99', false, 22)).toBe(`${CDN_BASE}/emojis/99.png?size=22`);
  });

  it('requests animated emoji as animated webp', () => {
    expect(emojiUrl('99', true)).toBe(`${CDN_BASE}/emojis/99.webp?size=44&animated=true`);
  });
});

describe('stickerUrl', () => {
  it('returns png for PNG / APNG, gif for GIF stickers', () => {
    expect(stickerUrl('7', 1)).toBe(`${MEDIA_BASE}/stickers/7.png?size=160`);
    expect(stickerUrl('7', 2)).toBe(`${MEDIA_BASE}/stickers/7.png?size=160`);
    expect(stickerUrl('7', 4, 320)).toBe(`${MEDIA_BASE}/stickers/7.gif?size=320`);
  });

  it('has no static image for Lottie stickers', () => {
    expect(stickerUrl('7', 3)).toBeNull();
  });
});
