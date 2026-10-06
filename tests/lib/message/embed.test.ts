import { describe, expect, it } from 'vitest';
import type { Embed } from '@/lib/discord/types';
import { normalizeEmbed } from '@/lib/message';

const PROXY = 'https://images-ext-1.discordapp.net/external/abc/https/example.com/pic.png';
const CDN = 'https://cdn.discordapp.com/attachments/1/2/pic.png';

describe('normalizeEmbed: a full rich embed', () => {
  const embed: Embed = {
    type: 'rich',
    title: 'Release 1.0',
    url: 'https://example.com/release',
    description: 'It is **out**.',
    timestamp: '2026-10-06T06:00:00.000000+00:00',
    color: 0x5865f2,
    footer: { text: 'Build bot', icon_url: 'https://example.com/f.png', proxy_icon_url: PROXY },
    image: { url: 'https://example.com/big.png', proxy_url: PROXY, width: 800, height: 600 },
    thumbnail: { url: 'https://example.com/t.png', proxy_url: CDN, width: 80, height: 80 },
    provider: { name: 'Example', url: 'https://example.com' },
    author: { name: 'Alice', url: 'https://example.com/alice', icon_url: 'https://example.com/a.png', proxy_icon_url: PROXY },
    fields: [
      { name: 'Version', value: '1.0', inline: true },
      { name: 'Notes', value: 'Many changes' },
    ],
  };

  it('maps every part', () => {
    expect(normalizeEmbed(embed)).toEqual({
      type: 'rich',
      title: 'Release 1.0',
      titleUrl: 'https://example.com/release',
      description: 'It is **out**.',
      author: { name: 'Alice', url: 'https://example.com/alice', iconUrl: PROXY },
      provider: 'Example',
      fields: [
        { name: 'Version', value: '1.0', inline: true },
        { name: 'Notes', value: 'Many changes', inline: false },
      ],
      footer: { text: 'Build bot', iconUrl: PROXY },
      timestamp: '2026-10-06T06:00:00.000000+00:00',
      colorHex: '#5865f2',
      image: { url: PROXY, width: 800, height: 600 },
      thumbnail: { url: CDN, width: 80, height: 80 },
      video: null,
    });
  });
});

describe('normalizeEmbed: colour', () => {
  const hex = (color: unknown) => normalizeEmbed({ color } as Embed).colorHex;

  it('renders a zero-padded lowercase #rrggbb', () => {
    expect(hex(0x5865f2)).toBe('#5865f2');
    expect(hex(0xff0000)).toBe('#ff0000');
    expect(hex(0x00ff)).toBe('#0000ff');
    expect(hex(0)).toBe('#000000');
    expect(hex(0xffffff)).toBe('#ffffff');
  });

  it('is null for missing or invalid colours', () => {
    expect(hex(undefined)).toBeNull();
    expect(hex(null)).toBeNull();
    expect(hex(-1)).toBeNull();
    expect(hex(0x1000000)).toBeNull();
    expect(hex(1.5)).toBeNull();
    expect(hex(Number.NaN)).toBeNull();
    expect(hex('#ff0000')).toBeNull();
  });
});

describe('normalizeEmbed: privacy rule for media', () => {
  it('drops a third-party image that has no Discord proxy', () => {
    const out = normalizeEmbed({ image: { url: 'http://evil.example/x.png' }, thumbnail: { url: 'https://evil.example/t.png' } });
    expect(out.image).toBeNull();
    expect(out.thumbnail).toBeNull();
  });

  it('uses the Discord proxy even when the original url is third-party', () => {
    const out = normalizeEmbed({ image: { url: 'http://evil.example/x.png', proxy_url: PROXY, width: 10, height: 20 } });
    expect(out.image).toEqual({ url: PROXY, width: 10, height: 20 });
  });

  it('prefers proxy_url, so a hostile proxy_url is dropped rather than replaced by url', () => {
    const out = normalizeEmbed({ image: { url: CDN, proxy_url: 'http://evil.example/x.png' } });
    expect(out.image).toBeNull();
  });

  it('accepts a Discord-hosted url when there is no proxy_url', () => {
    expect(normalizeEmbed({ image: { url: CDN } }).image).toEqual({ url: CDN, width: null, height: null });
  });

  it('rejects look-alike hosts and URL tricks', () => {
    const bad = [
      'https://cdn.discordapp.com.evil.example/x.png',
      'https://evil.example/cdn.discordapp.com/x.png',
      'https://cdn.discordapp.com@evil.example/x.png',
      'https://notdiscordapp.com/x.png',
      'ftp://cdn.discordapp.com/x.png',
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://cdn.discordapp.com/1234',
      '//evil.example/x.png',
      'https://cdn.discordapp.com/x.png\n.evil.example',
      '',
      '   ',
    ];
    for (const url of bad) {
      const out = normalizeEmbed({
        image: { url },
        thumbnail: { proxy_url: url },
        video: { url },
        footer: { text: 'f', icon_url: url },
        author: { name: 'a', icon_url: url },
      });
      expect(out.image, url).toBeNull();
      expect(out.thumbnail, url).toBeNull();
      expect(out.video, url).toBeNull();
      expect(out.footer?.iconUrl ?? null, url).toBeNull();
      expect(out.author?.iconUrl ?? null, url).toBeNull();
    }
  });

  it('lets inline raster data URIs through (demo mode) but not other data URIs', () => {
    const png = 'data:image/png;base64,AAAA';
    expect(normalizeEmbed({ image: { url: png } }).image?.url).toBe(png);
    expect(normalizeEmbed({ image: { url: 'data:text/html;base64,AAAA' } }).image).toBeNull();
    expect(normalizeEmbed({ image: { url: 'data:application/javascript,alert(1)' } }).image).toBeNull();
  });

  it('keeps text visible when every media URL is rejected', () => {
    const out = normalizeEmbed({
      title: 'Cat',
      description: 'A cat',
      url: 'https://example.com/cat',
      image: { url: 'http://evil.example/cat.png' },
    });
    expect(out.title).toBe('Cat');
    expect(out.description).toBe('A cat');
    expect(out.titleUrl).toBe('https://example.com/cat');
    expect(out.image).toBeNull();
  });

  it('only returns positive finite sizes', () => {
    const out = normalizeEmbed({ image: { url: CDN, width: 0, height: -3 } });
    expect(out.image).toEqual({ url: CDN, width: null, height: null });
    expect(normalizeEmbed({ image: { url: CDN, width: Number.NaN } }).image?.width).toBeNull();
  });
});

describe('normalizeEmbed: links are scheme-checked', () => {
  it('drops non-http(s) title/author URLs', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', 'ftp://example.com', 'mailto:a@b.c', 'not a url', '']) {
      const out = normalizeEmbed({ title: 't', url, author: { name: 'a', url } });
      expect(out.titleUrl, url).toBeNull();
      expect(out.author?.url ?? null, url).toBeNull();
      expect(out.title).toBe('t');
    }
  });

  it('keeps http and https', () => {
    expect(normalizeEmbed({ url: 'http://example.com/a' }).titleUrl).toBe('http://example.com/a');
    expect(normalizeEmbed({ url: 'https://example.com/a?b=1#c' }).titleUrl).toBe('https://example.com/a?b=1#c');
  });

  it('does not expose the provider URL', () => {
    expect(normalizeEmbed({ provider: { name: 'YouTube', url: 'javascript:alert(1)' } })).toMatchObject({ provider: 'YouTube' });
  });
});

describe('normalizeEmbed: video and gifv', () => {
  it('exposes a gifv video that is proxied by Discord, with the thumbnail as poster', () => {
    const video = 'https://images-ext-1.discordapp.net/external/abc/https/media.tenor.com/x.mp4';
    const out = normalizeEmbed({
      type: 'gifv',
      url: 'https://tenor.com/view/x',
      video: { url: 'https://media.tenor.com/x.mp4', proxy_url: video, width: 320, height: 240 },
      thumbnail: { url: 'https://media.tenor.com/x.png', proxy_url: PROXY },
    });
    expect(out.type).toBe('gifv');
    expect(out.video).toEqual({ url: video, posterUrl: PROXY });
    expect(out.thumbnail?.url).toBe(PROXY);
  });

  it('hides a third-party player (e.g. a YouTube iframe URL) but keeps the proxied thumbnail', () => {
    const out = normalizeEmbed({
      type: 'video',
      title: 'Clip',
      url: 'https://www.youtube.com/watch?v=abc',
      video: { url: 'https://www.youtube.com/embed/abc', width: 1280, height: 720 },
      thumbnail: { url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg', proxy_url: PROXY },
    });
    expect(out.video).toBeNull();
    expect(out.thumbnail?.url).toBe(PROXY);
    expect(out.titleUrl).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('has no poster when there is neither thumbnail nor image', () => {
    expect(normalizeEmbed({ video: { url: 'https://cdn.discordapp.com/attachments/1/2/v.mp4' } }).video).toEqual({
      url: 'https://cdn.discordapp.com/attachments/1/2/v.mp4',
      posterUrl: null,
    });
  });
});

describe('normalizeEmbed: missing and malformed fields', () => {
  it('returns an empty shell for {}', () => {
    expect(normalizeEmbed({})).toEqual({
      type: 'rich',
      title: null,
      titleUrl: null,
      description: null,
      author: null,
      provider: null,
      fields: [],
      footer: null,
      timestamp: null,
      colorHex: null,
      image: null,
      thumbnail: null,
      video: null,
    });
  });

  it('survives null/undefined/non-object input', () => {
    for (const bad of [null, undefined, 5, 'x', []]) {
      expect(() => normalizeEmbed(bad as unknown as Embed)).not.toThrow();
      expect(normalizeEmbed(bad as unknown as Embed).title).toBeNull();
    }
  });

  it('treats blank text as absent and ignores non-string values', () => {
    const out = normalizeEmbed({
      title: '   ',
      description: 42 as unknown as string,
      type: '' as string,
      author: { name: '' },
      footer: { text: ' ' },
    });
    expect(out.title).toBeNull();
    expect(out.description).toBeNull();
    expect(out.type).toBe('rich');
    expect(out.author).toBeNull();
    expect(out.footer).toBeNull();
  });

  it('drops invalid timestamps', () => {
    expect(normalizeEmbed({ timestamp: 'yesterday-ish' }).timestamp).toBeNull();
    expect(normalizeEmbed({ timestamp: '2026-10-06T06:00:00Z' }).timestamp).toBe('2026-10-06T06:00:00Z');
  });

  it('keeps well-formed fields and drops broken ones', () => {
    const out = normalizeEmbed({
      fields: [
        { name: 'ok', value: 'v', inline: true },
        { name: 'no value' } as unknown as { name: string; value: string },
        null as unknown as { name: string; value: string },
        { name: 5, value: 'x' } as unknown as { name: string; value: string },
        { name: ' ', value: ' ' },
        { name: 'blank-ish', value: String.fromCharCode(0x200b) },
        { name: 'x', value: 'y', inline: 'yes' as unknown as boolean },
      ],
    });
    expect(out.fields).toEqual([
      { name: 'ok', value: 'v', inline: true },
      { name: 'blank-ish', value: String.fromCharCode(0x200b), inline: false },
      { name: 'x', value: 'y', inline: false },
    ]);
  });

  it('handles a non-array fields value', () => {
    expect(normalizeEmbed({ fields: 'nope' as unknown as [] }).fields).toEqual([]);
  });
});
