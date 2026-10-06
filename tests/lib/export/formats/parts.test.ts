import { describe, expect, it } from 'vitest';
import type { Attachment, Message } from '../../../../src/lib/discord/types';
import { attachmentView, authorName, channelDisplay, channelPath, isBotMessage, listOf, localHref, localPathOf, safeLocalPath } from '../../../../src/lib/export/formats/parts';
import type { ExportTarget } from '../../../../src/lib/export/types';

const TARGET: ExportTarget = {
  channelId: '555',
  kind: 'text',
  channelName: 'general',
  guildId: '777',
  guildName: 'My Server',
  categoryName: 'Text Channels',
  parentChannelName: null,
  topic: null,
};

const file = (id: string, extra: Partial<Attachment> = {}): Attachment => ({ id, filename: 'a.png', size: 2048, url: 'https://cdn.discordapp.com/attachments/1/2/a.png', content_type: 'image/png', ...extra });

describe('safeLocalPath', () => {
  it.each([
    'chat_files/9_cat.png',
    'a.png',
    'Test Guild - general (2026-10-06)_files/1_cat.png',
    '일반_files/9_고양이.png',
    'a/b/c/d/e/f.png',
    '.hidden/file',
    'dir/..hidden',
    'name with spaces/and%percent#hash?query.png',
  ])('accepts %j', (path) => {
    expect(safeLocalPath(path)).toBe(path);
  });

  it.each([
    '',
    '/',
    '/abs.png',
    '//host/share/x.png',
    '../up.png',
    'a/../b.png',
    'a/..',
    './a.png',
    'a/./b.png',
    'a//b.png',
    'a/',
    'a\\b.png',
    '..\\x',
    'C:/Windows/x.png',
    'C:\\Windows\\x.png',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'http://example.com/x.png',
    'ok:but/x.png',
    'a\u0000b',
    'a\nb',
    'a\u001fb',
    'a\u007fb',
    'x'.repeat(1025),
  ])('refuses %j', (path) => {
    expect(safeLocalPath(path)).toBeNull();
  });

  it('allows a colon after the first segment (ids and times never have one, but it cannot form a scheme there)', () => {
    expect(safeLocalPath('dir/a:b.png')).toBe('dir/a:b.png');
  });

  it('refuses everything that is not a string', () => {
    for (const value of [null, undefined, 5, {}, [], ['a/b'], true]) expect(safeLocalPath(value)).toBeNull();
  });

  it('accepts the longest allowed path', () => {
    expect(safeLocalPath('x'.repeat(1024))).toBe('x'.repeat(1024));
  });
});

describe('localHref', () => {
  it('leaves letters, digits, marks and -_.~ alone, segment by segment', () => {
    expect(localHref('chat_files/9_cat.png')).toBe('chat_files/9_cat.png');
    expect(localHref('일반_files/9_고양이.png')).toBe('일반_files/9_고양이.png');
    expect(localHref('a-b_c.d~e/f')).toBe('a-b_c.d~e/f');
  });

  it('percent-encodes spaces, quotes, brackets, # ? % and the other reserved characters as UTF-8', () => {
    expect(localHref('my chat (1)/a b#c?d%e.png')).toBe('my%20chat%20%281%29/a%20b%23c%3Fd%25e.png');
    expect(localHref(`x" onerror="alert(1)`)).toBe('x%22%20onerror%3D%22alert%281%29');
    expect(localHref('x/<>&\'`[]{}|^;:@,$+!*')).toBe('x/%3C%3E%26%27%60%5B%5D%7B%7D%7C%5E%3B%3A%40%2C%24%2B%21%2A');
    expect(localHref('a/\u202e/b')).toBe('a/%E2%80%AE/b');
    expect(localHref('😀/x')).toBe('%F0%9F%98%80/x');
  });

  it('keeps the slashes between segments', () => {
    expect(localHref('a b/c d/e f')).toBe('a%20b/c%20d/e%20f');
  });

  it('does not let a percent escape of the input turn into a different path', () => {
    expect(localHref('%2e%2e/x')).toBe('%252e%252e/x');
  });

  it('returns null for what safeLocalPath refuses', () => {
    expect(localHref('../x')).toBeNull();
    expect(localHref('/x')).toBeNull();
    expect(localHref('javascript:alert(1)')).toBeNull();
    expect(localHref(undefined)).toBeNull();
  });

  it('survives a lone surrogate', () => {
    expect(localHref(`a/${String.fromCharCode(0xd800)}/b`)).toBe('a/%EF%BF%BD/b');
  });

  it('is decodable: decodeURIComponent of every segment gives back the path', () => {
    for (const path of ['my chat (1)/a b#c?d%e.png', '일반 채널/고양이 사진.png', 'x" y/z']) {
      expect(localHref(path)!.split('/').map(decodeURIComponent).join('/')).toBe(path);
    }
  });
});

describe('localPathOf and attachmentView', () => {
  const paths = new Map([['9', 'f/9_a.png'], ['10', '../evil'], ['11', '']]);

  it('finds the copy by the id of the attachment', () => {
    expect(localPathOf(file('9'), paths)).toBe('f/9_a.png');
  });

  it('knows nothing without a map, for an unknown id, or for a path that is not safe', () => {
    expect(localPathOf(file('9'), undefined)).toBeNull();
    expect(localPathOf(file('8'), paths)).toBeNull();
    expect(localPathOf(file('10'), paths)).toBeNull();
    expect(localPathOf(file('11'), paths)).toBeNull();
    expect(localPathOf({ ...file('9'), id: undefined } as unknown as Attachment, paths)).toBeNull();
    expect(localPathOf(null as unknown as Attachment, paths)).toBeNull();
  });

  it('puts the copy into the view of an attachment', () => {
    expect(attachmentView(file('9'), 'en', paths)).toMatchObject({ name: 'a.png', size: '2 KB', url: 'https://cdn.discordapp.com/attachments/1/2/a.png', local: 'f/9_a.png', kind: 'image', spoiler: false });
    expect(attachmentView(file('9'), 'en').local).toBeNull();
    expect(attachmentView(file('8'), 'en', paths).local).toBeNull();
  });
});

describe('small helpers of the text formats', () => {
  it('listOf passes arrays and turns everything else into an empty list', () => {
    expect(listOf([1, 2])).toEqual([1, 2]);
    expect(listOf(undefined)).toEqual([]);
    expect(listOf(null)).toEqual([]);
    expect(listOf('abc' as unknown as string[])).toEqual([]);
  });

  it('isBotMessage: bots and webhooks', () => {
    const base = { id: '1', channel_id: '1', content: '', timestamp: '', type: 0 } as Message;
    expect(isBotMessage({ ...base, author: { id: '1', username: 'a', bot: true } })).toBe(true);
    expect(isBotMessage({ ...base, author: { id: '1', username: 'a' }, webhook_id: '5' })).toBe(true);
    expect(isBotMessage({ ...base, author: { id: '1', username: 'a' } })).toBe(false);
    expect(isBotMessage({ ...base })).toBe(false);
  });

  it('authorName: the display name on one line, or the localised unknown user', () => {
    const base = { id: '1', channel_id: '1', content: '', timestamp: '', type: 0 } as Message;
    expect(authorName({ ...base, author: { id: '1', username: 'alice', global_name: 'Alice\nA' } }, 'en')).toBe('Alice A');
    expect(authorName({ ...base }, 'en')).toBe('Unknown user');
    expect(authorName({ ...base }, 'ko')).toBe('알 수 없는 사용자');
  });

  it('channelDisplay and channelPath', () => {
    expect(channelDisplay(TARGET)).toBe('#general');
    expect(channelPath(TARGET)).toBe('Text Channels / #general');
    expect(channelDisplay({ ...TARGET, kind: 'thread', parentChannelName: 'general', channelName: 'plan' })).toBe('#general / plan');
    expect(channelDisplay({ ...TARGET, kind: 'dm', channelName: 'Bob', guildId: null, guildName: null, categoryName: 'ignored' })).toBe('Bob');
    expect(channelPath({ ...TARGET, kind: 'dm', channelName: 'Bob', categoryName: 'ignored' })).toBe('Bob');
    expect(channelDisplay({ ...TARGET, channelName: '' })).toBe('#555');
    expect(channelPath({ ...TARGET, categoryName: null })).toBe('#general');
  });
});
