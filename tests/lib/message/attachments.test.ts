import { describe, expect, it } from 'vitest';
import type { Attachment } from '@/lib/discord/types';
import { attachmentMediaUrl, classifyAttachment, formatBytes, isSpoilerAttachment } from '@/lib/message';

const att = (over: Partial<Attachment> = {}): Attachment => ({
  id: '1',
  filename: 'file.bin',
  size: 10,
  url: 'https://cdn.discordapp.com/attachments/1/2/file.bin?ex=1',
  ...over,
});

describe('classifyAttachment', () => {
  it('goes by content_type first', () => {
    expect(classifyAttachment(att({ content_type: 'image/png', filename: 'x.bin' }))).toBe('image');
    expect(classifyAttachment(att({ content_type: 'video/mp4', filename: 'x.bin' }))).toBe('video');
    expect(classifyAttachment(att({ content_type: 'audio/ogg', filename: 'x.bin' }))).toBe('audio');
    expect(classifyAttachment(att({ content_type: 'application/pdf', filename: 'x.pdf' }))).toBe('file');
  });

  it('ignores case and parameters in content_type', () => {
    expect(classifyAttachment(att({ content_type: 'IMAGE/JPEG; charset=binary' }))).toBe('image');
    expect(classifyAttachment(att({ content_type: ' video/webm ' }))).toBe('video');
  });

  it('content_type beats a misleading extension', () => {
    expect(classifyAttachment(att({ content_type: 'video/mp4', filename: 'cat.png' }))).toBe('video');
  });

  it('falls back to the extension when content_type is missing or generic', () => {
    expect(classifyAttachment(att({ filename: 'cat.PNG' }))).toBe('image');
    expect(classifyAttachment(att({ filename: 'cat.jpeg', content_type: 'application/octet-stream' }))).toBe('image');
    expect(classifyAttachment(att({ filename: 'clip.MOV' }))).toBe('video');
    expect(classifyAttachment(att({ filename: 'clip.webm' }))).toBe('video');
    expect(classifyAttachment(att({ filename: 'voice.ogg' }))).toBe('audio');
    expect(classifyAttachment(att({ filename: 'song.mp3', content_type: '' }))).toBe('audio');
    expect(classifyAttachment(att({ filename: 'a.tar.gz' }))).toBe('file');
  });

  it('counts SVG as an image (loading is gated by attachmentMediaUrl)', () => {
    expect(classifyAttachment(att({ content_type: 'image/svg+xml' }))).toBe('image');
    expect(classifyAttachment(att({ filename: 'logo.svg' }))).toBe('image');
  });

  it('treats unknown, extension-less or missing names as plain files', () => {
    expect(classifyAttachment(att({ filename: 'README' }))).toBe('file');
    expect(classifyAttachment(att({ filename: 'trailing.' }))).toBe('file');
    expect(classifyAttachment(att({ filename: '.png' }))).toBe('image');
    expect(classifyAttachment({ ...att(), filename: undefined } as unknown as Attachment)).toBe('file');
    expect(classifyAttachment({} as unknown as Attachment)).toBe('file');
  });
});

describe('isSpoilerAttachment', () => {
  it('recognises the SPOILER_ filename prefix (case sensitive)', () => {
    expect(isSpoilerAttachment(att({ filename: 'SPOILER_cat.png' }))).toBe(true);
    expect(isSpoilerAttachment(att({ filename: 'spoiler_cat.png' }))).toBe(false);
    expect(isSpoilerAttachment(att({ filename: 'cat_SPOILER_.png' }))).toBe(false);
    expect(isSpoilerAttachment(att({ filename: 'cat.png' }))).toBe(false);
  });

  it('also honours the IS_SPOILER attachment flag', () => {
    expect(isSpoilerAttachment(att({ filename: 'cat.png', flags: 8 }))).toBe(true);
    expect(isSpoilerAttachment(att({ filename: 'cat.png', flags: 8 | 1 }))).toBe(true);
    expect(isSpoilerAttachment(att({ filename: 'cat.png', flags: 1 | 32 }))).toBe(false);
  });

  it('is false for broken data', () => {
    expect(isSpoilerAttachment({} as unknown as Attachment)).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats with 1024-based units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(25 * 1024 * 1024 + 300_000)).toBe('25.3 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB');
  });

  it('never prints 1,024 of a unit', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB');
    expect(formatBytes(1024 ** 3 - 1)).toBe('1 GB');
  });

  it('stays in TB for huge values', () => {
    expect(formatBytes(3 * 1024 ** 5)).toBe('3072 TB');
  });

  it('accepts a locale', () => {
    expect(formatBytes(1536, 'ko')).toBe('1.5 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
  });

  it('renders invalid input as 0 B', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number, '12' as unknown as number]) {
      expect(formatBytes(bad)).toBe('0 B');
    }
  });
});

describe('attachmentMediaUrl', () => {
  it('prefers the proxy url and keeps Discord hosts', () => {
    expect(
      attachmentMediaUrl(att({ proxy_url: 'https://media.discordapp.net/attachments/1/2/x.png' })),
    ).toBe('https://media.discordapp.net/attachments/1/2/x.png');
    expect(attachmentMediaUrl(att({ url: 'https://cdn.discordapp.com/attachments/1/2/x.png?ex=1' }))).toBe(
      'https://cdn.discordapp.com/attachments/1/2/x.png?ex=1',
    );
  });

  it('drops anything that is not a Discord host', () => {
    expect(attachmentMediaUrl(att({ url: 'http://evil.example/x.png' }))).toBeNull();
    expect(attachmentMediaUrl(att({ url: 'javascript:alert(1)' }))).toBeNull();
    expect(attachmentMediaUrl(att({ url: 'https://cdn.discordapp.com.evil.example/x.png' }))).toBeNull();
    expect(attachmentMediaUrl(att({ url: 'https://cdn.discordapp.com@evil.example/x.png' }))).toBeNull();
    expect(attachmentMediaUrl({} as unknown as Attachment)).toBeNull();
  });
});
