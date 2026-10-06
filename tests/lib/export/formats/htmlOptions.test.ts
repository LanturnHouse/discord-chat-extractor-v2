// @vitest-environment jsdom
/**
 * What V2 adds to the HTML writer (docs/PLAN.md #12, §6): the scope rows of the header card (incremental / partial), saved
 * attachment copies (`WriterOptions.attachmentPaths`: local `src` / `href`, the CSP variant and the footer note), the content
 * options, and the two themes. The rest of the writer (everything v1 had) is covered by html.test.ts and htmlSecurity.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ALICE, BOT, context, DAY, message, namesFor, parseDocument, renderExport, tagProblems } from './htmlTestKit';
import type { Attachment, Message } from '../../../../src/lib/discord/types';
import { contentSecurityPolicy, htmlFormat } from '../../../../src/lib/export/formats/html';
import type { WriterOptions } from '../../../../src/lib/export/types';

const CSP_BASE =
  "default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";
const CSP_LOCAL =
  "default-src 'none'; img-src 'self' file: https: data:; media-src 'self' file: https:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";

const CDN = 'https://cdn.discordapp.com/attachments/1/2';
const MEDIA = 'https://media.discordapp.net/attachments/1/2';

function attachment(id: string, filename: string, contentType: string, extra: Partial<Attachment> = {}): Attachment {
  return { id, filename, content_type: contentType, size: 2048, url: `${CDN}/${filename}`, proxy_url: `${MEDIA}/${filename}`, ...extra };
}

function must<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element: ${selector}`);
  return found;
}

const all = (root: ParentNode, selector: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(selector));
const classesOf = (element: Element): string[] => Array.from(element.classList);

function exported(messages: readonly Message[], options: Partial<WriterOptions> = {}): Document {
  return parseDocument(renderExport([messages], context({ options, names: namesFor(messages) })));
}

const articleOf = (doc: Document, n: number): HTMLElement => must(doc, `article[data-message-id="${message(n, '').id}"]`);
const paths = (entries: Record<string, string>): Partial<WriterOptions> => ({ attachmentPaths: new Map(Object.entries(entries)) });
const cspOf = (doc: Document): string | null => must(doc, 'meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
const noteOf = (doc: Document): string => must(doc, '.dce-footer__note').textContent ?? '';

describe('header card: incremental and partial exports', () => {
  const rowsOf = (doc: Document): Array<[string | null, string | null | undefined]> =>
    all(doc, 'header .dce-meta dt').map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);

  it('has exactly the rows of a plain export when neither flag is set', () => {
    const plain = rowsOf(exported([message(1, 'x')]));
    expect(plain.map(([label]) => label)).toEqual(['Range', 'Exported', 'Generator']);
    expect(rowsOf(exported([message(1, 'x')], { incremental: false, partial: false }))).toEqual(plain);
  });

  it('adds the incremental and the partial rows right behind the range', () => {
    expect(rowsOf(exported([message(1, 'x')], { incremental: true, partial: true, limit: 50 }))).toEqual([
      ['Range', 'newest 50 messages'],
      ['Incremental', 'only messages after the previous export'],
      ['Status', 'Partial - the export stopped early, so messages may be missing'],
      ['Exported', '2026-10-06 12:34:56 (UTC)'],
      ['Generator', 'Discord Chat Extractor'],
    ]);
  });

  it('each flag adds only its own row', () => {
    expect(rowsOf(exported([message(1, 'x')], { incremental: true })).map(([label]) => label)).toEqual(['Range', 'Incremental', 'Exported', 'Generator']);
    expect(rowsOf(exported([message(1, 'x')], { partial: true })).map(([label]) => label)).toEqual(['Range', 'Status', 'Exported', 'Generator']);
  });

  it('writes the rows in Korean for the ko locale', () => {
    expect(rowsOf(exported([message(1, 'x')], { incremental: true, partial: true, locale: 'ko' })).slice(0, 3)).toEqual([
      ['범위', '전체 메시지'],
      ['증분', '지난번 내보낸 이후의 메시지만'],
      ['상태', '부분 저장 - 중간에 중단되어 일부 메시지가 빠졌을 수 있습니다'],
    ]);
  });

  it('is still well-formed HTML', () => {
    expect(tagProblems(renderExport([[message(1, 'x')]], context({ options: { incremental: true, partial: true } })))).toEqual([]);
  });
});

describe('saved attachment copies (WriterOptions.attachmentPaths)', () => {
  const png = (id = '9', filename = 'cat.png', extra: Partial<Attachment> = {}): Attachment => attachment(id, filename, 'image/png', extra);
  const articleWith = (attachments: Attachment[], options: Partial<WriterOptions>, extra: Partial<Message> = {}): HTMLElement =>
    articleOf(exported([message(1, '', { attachments, ...extra })], options), 1);

  it('shows a saved picture from its copy and links to the copy instead of the CDN', () => {
    const article = articleWith([png()], paths({ '9': 'general_files/9_cat.png' }));
    const img = must<HTMLImageElement>(article, 'a.msg-image-link > img.msg-image');
    expect(img.getAttribute('src')).toBe('general_files/9_cat.png');
    expect(must(article, 'a.msg-image-link').getAttribute('href')).toBe('general_files/9_cat.png');
    const attachments = must(article, '.msg-attachments').innerHTML;
    expect(attachments).not.toContain('cdn.discordapp.com');
    expect(attachments).not.toContain('media.discordapp.net');
  });

  it('percent-encodes every path segment so no character can end or change the reference', () => {
    const article = articleWith([png()], paths({ '9': 'my chat (2026-10-06)_files/9_cat #1 "a" & b?.png' }));
    const img = must<HTMLImageElement>(article, 'img.msg-image');
    expect(img.getAttribute('src')).toBe('my%20chat%20%282026-10-06%29_files/9_cat%20%231%20%22a%22%20%26%20b%3F.png');
    expect(must(article, 'a.msg-image-link').getAttribute('href')).toBe(img.getAttribute('src'));
  });

  it('keeps Korean letters readable and encodes the rest as UTF-8', () => {
    const article = articleWith([png()], paths({ '9': '일반_files/9_고양이 사진.png' }));
    expect(must(article, 'img.msg-image').getAttribute('src')).toBe('일반_files/9_고양이%20사진.png');
  });

  it('shows a saved copy of a picture that is not hosted by Discord: it came from the exporter, not from the message', () => {
    const foreign = png('9', 'cat.png', { url: 'https://example.com/cat.png', proxy_url: undefined });
    const without = articleWith([foreign], {});
    expect(without.querySelector('.msg-attachments img')).toBeNull();
    const article = articleWith([foreign], paths({ '9': 'f/9_cat.png' }));
    expect(must(article, 'img.msg-image').getAttribute('src')).toBe('f/9_cat.png');
  });

  it('plays saved video and audio from their copies', () => {
    const article = articleWith(
      [attachment('10', 'clip.mp4', 'video/mp4'), attachment('11', 'note.mp3', 'audio/mpeg')],
      paths({ '10': 'f/10_clip.mp4', '11': 'f/11_note.mp3' }),
    );
    expect(must(article, 'video.msg-video').getAttribute('src')).toBe('f/10_clip.mp4');
    const card = must(article, '.msg-attachment--audio');
    expect(must(card, 'audio.msg-audio').getAttribute('src')).toBe('f/11_note.mp3');
    expect(must(card, 'a.msg-file__name').getAttribute('href')).toBe('f/11_note.mp3');
  });

  it('links a saved file card to the copy and keeps its name and size', () => {
    const article = articleWith([attachment('12', 'report.pdf', 'application/pdf', { size: 1536 })], paths({ '12': 'f/12_report.pdf' }));
    const link = must(article, 'a.msg-file__name');
    expect(link.getAttribute('href')).toBe('f/12_report.pdf');
    expect(link.textContent).toBe('report.pdf');
    expect(must(article, '.msg-file__size').textContent).toBe('1.5 KB');
  });

  it('keeps the spoiler cover on a saved copy and does not leak the description', () => {
    const article = articleWith([png('9', 'SPOILER_secret.png', { description: 'the secret' })], paths({ '9': 'f/9_SPOILER_secret.png' }));
    const frame = must(article, '.msg-attachment--image');
    expect(classesOf(frame)).toContain('msg-attachment--spoiler');
    expect(must(frame, 'img.msg-image').getAttribute('src')).toBe('f/9_SPOILER_secret.png');
    expect(must(frame, 'img.msg-image').getAttribute('alt')).toBe('');
    expect(frame.querySelector('.msg-spoiler-cover')).not.toBeNull();
    expect(article.innerHTML).not.toContain('the secret');
  });

  it('only the attachments that have a copy use it; the others stay as they were', () => {
    const article = articleWith([png('9', 'a.png'), png('10', 'b.png')], paths({ '9': 'f/9_a.png' }));
    const sources = all(article, 'img.msg-image').map((img) => img.getAttribute('src'));
    expect(sources).toEqual(['f/9_a.png', `${MEDIA}/b.png`]);
  });

  it('covers the attachments of a forwarded message', () => {
    const doc = exported(
      [message(1, '', { message_reference: { type: 1 }, message_snapshots: [{ message: { content: 'look', attachments: [png()] } }] })],
      paths({ '9': 'f/9_cat.png' }),
    );
    expect(must(doc, '.msg-forward img.msg-image').getAttribute('src')).toBe('f/9_cat.png');
  });

  it('refuses a path that is not a safe relative path and falls back to the CDN', () => {
    for (const hostile of ['../../etc/passwd', '/abs/cat.png', 'C:\\x\\cat.png', 'a/../b.png', 'a//b.png', './a.png', 'a\u0007b.png', 'dir\\file.png', '']) {
      const article = articleWith([png()], paths({ '9': hostile }));
      expect(must(article, 'img.msg-image').getAttribute('src'), JSON.stringify(hostile)).toBe(`${MEDIA}/cat.png`);
    }
  });

  it('leaves embeds alone: they always load from Discord', () => {
    const article = articleWith([], paths({ '9': 'f/9_cat.png' }), {
      embeds: [{ type: 'image', url: 'https://example.com/', image: { url: `${CDN}/embed.png`, proxy_url: `${MEDIA}/embed.png`, width: 100, height: 100 } }],
    });
    expect(must(article, '.msg-embed img').getAttribute('src')).toBe(`${MEDIA}/embed.png`);
  });

  it('is the same file as without options when no attachment has a copy', () => {
    const messages = [message(1, 'x', { attachments: [png()] })];
    const plain = renderExport([messages], context({ names: namesFor(messages) }));
    expect(renderExport([messages], context({ names: namesFor(messages), options: { attachmentPaths: new Map() } }))).toBe(plain);
  });

  describe('Content-Security-Policy and footer note', () => {
    it('keeps the strict policy of a plain export, also for an empty map', () => {
      expect(cspOf(exported([message(1, 'x')]))).toBe(CSP_BASE);
      expect(cspOf(exported([message(1, 'x')], { attachmentPaths: new Map() }))).toBe(CSP_BASE);
      expect(contentSecurityPolicy(false)).toBe(CSP_BASE);
    });

    it('lets an export with saved copies load from its own folder and nothing else', () => {
      const doc = exported([message(1, 'x', { attachments: [png()] })], paths({ '9': 'f/9_cat.png' }));
      expect(cspOf(doc)).toBe(CSP_LOCAL);
      expect(contentSecurityPolicy(true)).toBe(CSP_LOCAL);
      // nothing but images and media got wider: no script, frame, connect, font, form or base-uri permission appears
      expect(CSP_LOCAL.replace(/img-src [^;]+/, 'img-src https: data:').replace(/media-src [^;]+/, 'media-src https:')).toBe(CSP_BASE);
      expect(CSP_LOCAL).not.toMatch(/script-src|frame-src|connect-src|unsafe-eval|object-src/);
    });

    it('says in the footer which links keep working, in both languages', () => {
      const withCopies = exported([message(1, 'x', { attachments: [png()] })], paths({ '9': 'f/9_cat.png' }));
      expect(noteOf(withCopies)).toBe(
        "Attachments saved next to this file keep working. Other links to Discord's servers (avatars, embeds, attachments that were not saved) expire after a while.",
      );
      const ko = exported([message(1, 'x', { attachments: [png()] })], { ...paths({ '9': 'f/9_cat.png' }), locale: 'ko' });
      expect(noteOf(ko)).toContain('이 파일 옆에 저장된 첨부 파일은 계속 열립니다.');
      expect(noteOf(exported([message(1, 'x')]))).toMatch(/^Links to attachments and other media on Discord's servers expire after a while/);
    });
  });
});

describe('content options (docs/PLAN.md #12)', () => {
  const EVERYTHING = { includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: true };
  const human = message(1, 'hello');
  const bot = message(2, 'beep', { author: BOT });
  const webhook = message(3, 'hook', { webhook_id: '777' });
  const join = message(4, '', { type: 7 });
  const again = message(5, 'again');
  const all5 = [human, bot, webhook, join, again];
  const withContent = (content: Partial<typeof EVERYTHING>): Partial<WriterOptions> => ({ content: { ...EVERYTHING, ...content } });
  const idsOf = (doc: Document): string[] => all(doc, 'article').map((article) => article.dataset.messageId ?? '');
  const idOf = (n: number): string => message(n, '').id;

  it('writes the same file as without options when everything is included', () => {
    const plain = renderExport([all5], context({ names: namesFor(all5) }));
    expect(renderExport([all5], context({ names: namesFor(all5), options: { content: EVERYTHING } }))).toBe(plain);
  });

  it('leaves out bots and webhooks', () => {
    expect(idsOf(exported(all5, withContent({ includeBots: false })))).toEqual([idOf(1), idOf(4), idOf(5)]);
  });

  it('leaves out system messages', () => {
    expect(idsOf(exported(all5, withContent({ includeSystem: false })))).toEqual([idOf(1), idOf(2), idOf(3), idOf(5)]);
  });

  it('renders what is left as if the dropped messages never existed: grouping and dividers follow the kept messages', () => {
    const doc = exported([human, bot, again], withContent({ includeBots: false }));
    expect(classesOf(articleOf(doc, 1))).toContain('msg--first');
    // the bot message between the two would have broken the group
    expect(classesOf(articleOf(doc, 5))).toContain('msg--grouped');
    const dayLater = message(6, 'next day', { timestamp: new Date(Date.parse(human.timestamp) + DAY).toISOString() });
    expect(all(exported([human, bot, dayLater], withContent({ includeBots: false })), '.msg-day-divider')).toHaveLength(2);
  });

  it('drops the reaction bar and the embeds, also inside a forwarded message', () => {
    const rich = message(7, 'rich', {
      reactions: [{ count: 2, emoji: { id: null, name: '👍' } }],
      embeds: [{ type: 'rich', title: 'An embed', description: 'text' }],
    });
    const forwarded = message(8, '', {
      message_reference: { type: 1 },
      message_snapshots: [{ message: { content: 'fwd', embeds: [{ type: 'rich', title: 'Inner embed' }], attachments: [] } }],
    });
    const kept = exported([rich, forwarded], {});
    expect(all(kept, '.msg-reactions')).toHaveLength(1);
    expect(all(kept, '.msg-embed')).toHaveLength(2);
    const dropped = exported([rich, forwarded], withContent({ includeReactions: false, includeEmbeds: false }));
    expect(all(dropped, '.msg-reactions, .msg-embeds, .msg-embed')).toHaveLength(0);
    expect(must(dropped, '.msg-forward').textContent).toContain('fwd');
    expect(dropped.body.textContent).not.toContain('An embed');
    expect(dropped.body.textContent).not.toContain('Inner embed');
  });

  it('each part on its own', () => {
    const rich = message(7, 'rich', { reactions: [{ count: 2, emoji: { id: null, name: '👍' } }], embeds: [{ type: 'rich', title: 'An embed' }] });
    const noReactions = exported([rich], withContent({ includeReactions: false }));
    expect([all(noReactions, '.msg-reactions').length, all(noReactions, '.msg-embed').length]).toEqual([0, 1]);
    const noEmbeds = exported([rich], withContent({ includeEmbeds: false }));
    expect([all(noEmbeds, '.msg-reactions').length, all(noEmbeds, '.msg-embed').length]).toEqual([1, 0]);
  });

  it('a file whose messages were all dropped is still a complete document', () => {
    const html = renderExport([[bot, join]], context({ options: withContent({ includeBots: false, includeSystem: false }), names: namesFor([bot, join]) }), { messageCount: 0 });
    expect(tagProblems(html)).toEqual([]);
    expect(parseDocument(html).querySelectorAll('article')).toHaveLength(0);
    expect(must(parseDocument(html), '.dce-empty').textContent).toBe('No messages were found for this export.');
  });

  it('does not change the messages it was given', () => {
    const rich = message(7, 'rich', { reactions: [{ count: 2, emoji: { id: null, name: '👍' } }], embeds: [{ type: 'rich', title: 'An embed' }] });
    exported([rich], withContent({ includeReactions: false, includeEmbeds: false }));
    expect(rich.reactions).toHaveLength(1);
    expect(rich.embeds).toHaveLength(1);
  });

  it('applies to every batch of a file alike', () => {
    const writer = htmlFormat.createWriter(context({ options: withContent({ includeBots: false }), names: namesFor(all5) }));
    const chunks = [...writer.start(), ...writer.write([human, bot]), ...writer.write([webhook]), ...writer.write([again])];
    const html = chunks.join('');
    expect(html).toContain(`data-message-id="${idOf(1)}"`);
    expect(html).toContain(`data-message-id="${idOf(5)}"`);
    expect(html).not.toContain(`data-message-id="${idOf(2)}"`);
    expect(html).not.toContain(`data-message-id="${idOf(3)}"`);
  });
});

describe('themes', () => {
  it('differs between the dark and the light file only in the theme attribute and the colour scheme (both palettes are in the style block)', () => {
    const messages = [message(1, 'x', { author: ALICE })];
    const dark = renderExport([messages], context({ options: { htmlTheme: 'dark' } }));
    const light = renderExport([messages], context({ options: { htmlTheme: 'light' } }));
    expect(light).not.toBe(dark);
    expect(light.replace('<html lang="en" data-theme="light">', '<html lang="en" data-theme="dark">').replace('<meta name="color-scheme" content="light">', '<meta name="color-scheme" content="dark">')).toBe(dark);
  });

  it('is dark when no theme is given at all', () => {
    const { htmlTheme: _unused, ...rest } = context().options;
    const doc = parseDocument(renderExport([[]], { ...context(), options: rest as WriterOptions }));
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
