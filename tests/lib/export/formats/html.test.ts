// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALICE,
  at,
  asText,
  batchesOf,
  BOB,
  BOT,
  context,
  DAY,
  DM_TARGET,
  EXPORTED_AT,
  HOUR,
  message,
  MINUTE,
  namesFor,
  parseDocument,
  renderExport,
  repoFile,
  showcaseMessages,
  tagProblems,
  THREAD_TARGET,
} from './htmlTestKit';
import { MOCK_IDS } from '../../../../src/lib/discord/mock';
import type { Attachment, Embed, Message, User } from '../../../../src/lib/discord/types';
import { htmlFormat } from '../../../../src/lib/export/formats/html';
import { exportedTokenNames, exportStyles } from '../../../../src/lib/export/formats/html/css';
import { createHtmlEnv, loadableImage, loadableMedia, renderMessageItem } from '../../../../src/lib/export/formats/html/message';
import type { WriterOptions, ExportTarget } from '../../../../src/lib/export/types';
import { buildNameResolver } from '../../../../src/lib/message';
import { exportMock, textOf as outputText } from '../exportKit';
import { expectLinearScaling } from '../scaling';
import themeCss from '../../../../src/lib/export/formats/html/theme.css?raw';

const CSP =
  "default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";

const CDN = 'https://cdn.discordapp.com/attachments/1/2';
const MEDIA = 'https://media.discordapp.net/attachments/1/2';

function attachment(filename: string, contentType: string, extra: Partial<Attachment> = {}): Attachment {
  return { id: '9', filename, content_type: contentType, size: 2048, url: `${CDN}/${filename}`, proxy_url: `${MEDIA}/${filename}`, ...extra };
}

function must<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element: ${selector}`);
  return found;
}

const all = (root: ParentNode, selector: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(selector));
const textOf = (root: ParentNode, selector: string): string => must(root, selector).textContent ?? '';
const classesOf = (element: Element): string[] => Array.from(element.classList);

interface Setup {
  options?: Partial<WriterOptions>;
  target?: Partial<ExportTarget>;
}

/** The whole exported document of `messages` (one batch), parsed. */
function exported(messages: readonly Message[], setup: Setup = {}): Document {
  const names = namesFor(messages);
  return parseDocument(renderExport([messages], context({ ...setup, names })));
}

/** The `article` element of the message with the given number (see `message()`). */
function articleOf(doc: Document, n: number): HTMLElement {
  return must(doc, `article[data-message-id="${message(n, '').id}"]`);
}

/** A single message rendered on its own, parsed, and its `article`. */
function single(extra: Partial<Message>, content = 'hello', setup: Setup = {}): HTMLElement {
  return articleOf(exported([message(1, content, extra)], setup), 1);
}

// ---------------------------------------------------------------------------------------------------------------------

describe('document', () => {
  const html = renderExport([[message(1, 'hello')]]);
  const doc = parseDocument(html);

  it('is a complete HTML5 document', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en" data-theme="dark">\n<head>\n<meta charset="utf-8">')).toBe(true);
    expect(html.endsWith('</footer>\n</div>\n</body>\n</html>\n')).toBe(true);
    expect(doc.compatMode).toBe('CSS1Compat');
    expect(tagProblems(html)).toEqual([]);
  });

  it('declares charset, viewport, generator, referrer policy and colour scheme', () => {
    const metas = all(doc.head, 'meta').map((m) => [m.getAttribute('name') ?? m.getAttribute('http-equiv') ?? 'charset', m.getAttribute('content') ?? m.getAttribute('charset')]);
    expect(metas).toEqual([
      ['charset', 'utf-8'],
      ['Content-Security-Policy', CSP],
      ['viewport', 'width=device-width, initial-scale=1'],
      ['referrer', 'no-referrer'],
      ['generator', 'Discord Chat Extractor'],
      ['color-scheme', 'dark'],
    ]);
  });

  it('puts the CSP before the style and title, and has no script anywhere', () => {
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style>'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'));
    expect(doc.querySelectorAll('script, iframe, object, embed, form, link, base').length).toBe(0);
    expect(/<script/i.test(html)).toBe(false);
  });

  it('has the title "Server - #channel" and exactly one style element holding the shared stylesheet', () => {
    expect(doc.title).toBe('My Server - #general');
    const styles = all(doc, 'style');
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe(exportStyles());
  });

  it('writes the header card: server, category / channel, topic, range, export time with zone, generator', () => {
    expect(textOf(doc, 'h1.dce-header__title')).toBe('My Server');
    expect(textOf(doc, '.dce-header__channel')).toBe('Text Channels / #general');
    expect(textOf(doc, '.dce-header__topic')).toBe('Welcome!');
    const rows = all(doc, 'header .dce-meta dt').map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ['Range', 'all messages'],
      ['Exported', '2026-10-06 12:34:56 (UTC)'],
      ['Generator', 'Discord Chat Extractor'],
    ]);
  });

  it('shows the export time in the requested zone and the requested range', () => {
    const seoul = exported([message(1, 'hi')], {
      options: { timeZone: 'Asia/Seoul', after: '2026-10-01T00:00:00.000Z', before: '2026-10-05T00:00:00.000Z' },
    });
    const rows = new Map(all(seoul, 'header .dce-meta dt').map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(rows.get('Exported')).toBe('2026-10-06 21:34:56 (Asia/Seoul)');
    expect(rows.get('Range')).toBe('2026-10-01 09:00:00 to 2026-10-05 09:00:00');
  });

  it('describes a message count in the header card, in both languages', () => {
    const range = (options: Partial<WriterOptions>): string => {
      const header = exported([message(1, 'hi')], { options });
      // the first row of the header card is the range, whatever the language calls it
      return all(header, 'header .dce-meta dd')[0]!.textContent ?? '';
    };
    expect(range({ limit: 200 })).toBe('newest 200 messages');
    expect(range({ after: '2026-10-01T00:00:00.000Z', limit: 500 })).toBe('from 2026-10-01 00:00:00: newest 500 messages');
    expect(range({ before: '2026-10-05T00:00:00.000Z', limit: 200 })).toBe('until 2026-10-05 00:00:00: newest 200 messages');
    expect(range({ after: '2026-10-01T00:00:00.000Z', before: '2026-10-05T00:00:00.000Z', limit: 500, timeZone: 'Asia/Seoul' })).toBe(
      '2026-10-01 09:00:00 to 2026-10-05 09:00:00: newest 500 messages',
    );
    expect(range({ locale: 'ko', limit: 200 })).toBe('최근 200개 메시지');
    expect(range({ locale: 'ko', after: '2026-10-01T00:00:00.000Z', limit: 500 })).toBe('2026-10-01 00:00:00부터 최근 500개');
    expect(range({ locale: 'ko', before: '2026-10-05T00:00:00.000Z', limit: 200 })).toBe('2026-10-05 00:00:00까지 최근 200개');
  });

  it('labels an unknown time zone as UTC, which is what the timestamps are really printed in', () => {
    const doc2 = exported([message(1, 'hi')], { options: { timeZone: 'Mars/Olympus' } });
    expect(all(doc2, 'header .dce-meta dd')[1]!.textContent).toBe('2026-10-06 12:34:56 (UTC)');
  });

  it('uses the light theme attribute and colour scheme when asked, and dark for anything else', () => {
    const light = parseDocument(renderExport([[]], context({ options: { htmlTheme: 'light' } })));
    expect(light.documentElement.getAttribute('data-theme')).toBe('light');
    expect(must(light, 'meta[name="color-scheme"]').getAttribute('content')).toBe('light');
    const odd = parseDocument(renderExport([[]], context({ options: { htmlTheme: 'neon' as WriterOptions['htmlTheme'] } })));
    expect(odd.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('writes fixed words in Korean for the ko locale', () => {
    const ko = exported([message(1, 'hi')], { options: { locale: 'ko' } });
    expect(ko.documentElement.lang).toBe('ko');
    expect(all(ko, 'header .dce-meta dt').map((dt) => dt.textContent)).toEqual(['범위', '내보낸 시각', '생성 도구']);
    expect(textOf(ko, '.dce-footer__note')).toContain('만료');
    expect(all(ko, 'footer .dce-meta dt')[0]!.textContent).toBe('메시지 수');
  });

  it('falls back to English for an unknown locale', () => {
    const odd = exported([message(1, 'hi')], { options: { locale: 'xx' as WriterOptions['locale'] } });
    expect(odd.documentElement.lang).toBe('en');
  });
});

describe('header card targets', () => {
  it('shows a direct message under the name of the conversation, without server or category', () => {
    const doc = parseDocument(renderExport([[]], context({ target: DM_TARGET })));
    expect(doc.title).toBe('Bob');
    expect(textOf(doc, 'h1.dce-header__title')).toBe('Bob');
    expect(doc.querySelector('.dce-header__channel')).toBeNull();
    expect(doc.querySelector('.dce-header__topic')).toBeNull();
    expect(textOf(doc, '.dce-header__acronym')).toBe('B');
  });

  it('shows a thread with its parent channel', () => {
    const doc = parseDocument(renderExport([[]], context({ target: THREAD_TARGET })));
    expect(doc.title).toBe('My Server - #general / release plan');
    expect(textOf(doc, '.dce-header__channel')).toBe('Text Channels / #general / release plan');
  });

  it('uses the first letters of the first three words of the server name as the fallback icon', () => {
    const acronym = (guildName: string): string =>
      textOf(parseDocument(renderExport([[]], context({ target: { guildName } }))), '.dce-header__acronym');
    expect(acronym('My Server')).toBe('MS');
    expect(acronym('Discord Chat Extractor Dev Team')).toBe('DCE');
    expect(acronym('  넓은   세상 ')).toBe('넓세');
    expect(acronym('rust')).toBe('R');
  });

  it.each([
    ['https://cdn.discordapp.com/icons/777/abc.png?size=96', true],
    ['https://media.discordapp.net/icons/777/abc.png', true],
    ['data:image/png;base64,AAAA', true],
    ['https://evil.example/icon.png', false],
    ['http://cdn.discordapp.com/icons/777/abc.png', false],
    ['javascript:alert(1)', false],
    ['data:text/html,<script>alert(1)</script>', false],
    ['file:///etc/passwd', false],
    [null, false],
  ])('shows the icon %s as a picture: %s', (iconUrl, picture) => {
    const doc = parseDocument(renderExport([[]], context({ target: { iconUrl } })));
    const img = doc.querySelector('img.dce-header__icon');
    if (picture) {
      expect(img?.getAttribute('src')).toBe(iconUrl);
      expect(doc.querySelector('.dce-header__acronym')).toBeNull();
    } else {
      expect(img).toBeNull();
      expect(doc.querySelector('.dce-header__acronym')).not.toBeNull();
    }
  });

  it('leaves out an empty topic', () => {
    const doc = parseDocument(renderExport([[]], context({ target: { topic: '  \n ' } })));
    expect(doc.querySelector('.dce-header__topic')).toBeNull();
  });
});

describe('footer and empty channels', () => {
  it('is valid HTML for a channel without messages and says so', () => {
    const html = renderExport([[]]);
    const doc = parseDocument(html);
    expect(tagProblems(html)).toEqual([]);
    expect(doc.querySelectorAll('main > *').length).toBe(1);
    expect(textOf(doc, 'main .dce-empty')).toBe('No messages were found for this export.');
    expect(all(doc, 'footer .dce-meta dd').map((dd) => dd.textContent)).toEqual(['0']);
  });

  it('is valid HTML when write() is never called', () => {
    const writer = htmlFormat.createWriter(context());
    const html = asText([...writer.start(), ...writer.end({ messageCount: 0, firstTimestamp: null, lastTimestamp: null })]);
    expect(tagProblems(html)).toEqual([]);
    expect(parseDocument(html).querySelector('main')).not.toBeNull();
  });

  it('writes the real count and the first and last timestamp (in the export zone) after the messages', () => {
    const messages = [message(1, 'a'), message(2, 'b', { timestamp: at(2 * HOUR) }), message(3, 'c', { timestamp: at(DAY) })];
    const doc = parseDocument(renderExport([messages], context({ options: { timeZone: 'Asia/Seoul' } })));
    const footer = all(doc, 'footer .dce-meta dt').map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(footer).toEqual([
      ['Messages', '3'],
      ['First message', '2026-10-05 21:00:01'],
      ['Last message', '2026-10-06 21:00:00'],
    ]);
    expect(doc.querySelector('.dce-empty')).toBeNull();
  });

  it('warns that attachment links expire', () => {
    const doc = exported([message(1, 'a')]);
    expect(textOf(doc, '.dce-footer__note')).toMatch(/expire/);
  });

  it('puts the footer after the last message', () => {
    const html = renderExport([[message(1, 'a'), message(2, 'b')]]);
    expect(html.lastIndexOf('</article>')).toBeLessThan(html.indexOf('<footer'));
    expect(html.indexOf('<main>')).toBeLessThan(html.indexOf('<article'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------------------------------------------------

describe('plain messages', () => {
  it('mirrors the React markup of a first message exactly', () => {
    const env = createHtmlEnv(context());
    const html = renderMessageItem(message(1, 'hello **world**'), undefined, env);
    expect(html).toBe(
      '<div class="msg-day-divider" role="separator" aria-label="October 5, 2026"><span class="msg-day-divider__label">October 5, 2026</span></div>' +
        '<article class="msg msg--first" data-message-id="100000000000000001" aria-label="Alice, Monday, October 5, 2026 at 12:00 PM">' +
        '<img class="msg-avatar" src="https://cdn.discordapp.com/embed/avatars/0.png" alt="" width="40" height="40" loading="lazy" decoding="async">' +
        '<div class="msg-body"><div class="msg-header"><span class="msg-author" dir="auto">Alice</span>' +
        '<time class="msg-timestamp" datetime="2026-10-05T12:00:01.000Z" title="Monday, October 5, 2026 at 12:00 PM">10/05/2026 12:00 PM</time></div>' +
        '<div class="msg-content" dir="auto"><div class="md-root">hello <strong>world</strong></div></div></div></article>',
    );
  });

  it('mirrors the React markup of a system message exactly', () => {
    const env = createHtmlEnv(context());
    const join = message(1, '', { type: 7 });
    const html = renderMessageItem(join, join, env);
    expect(html).toBe(
      '<article class="msg msg--system" data-message-id="100000000000000001">' +
        '<span class="msg-system__icon msg-system__icon--join"><svg class="msg-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path fill="currentColor" fill-rule="evenodd" d="M3 11h9.2L8.6 7.4 10 6l6 6-6 6-1.4-1.4 3.6-3.6H3v-2zM17 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v-2h2V6h-2V4z"/></svg></span>' +
        '<div class="msg-system__text"><span class="msg-system__actor">Alice</span> joined the server.' +
        '<time class="msg-timestamp" datetime="2026-10-05T12:00:01.000Z" title="Monday, October 5, 2026 at 12:00 PM">10/05/2026 12:00 PM</time></div></article>',
    );
  });

  it('shows the display name, falling back to the user name, and the avatar fallback circle for an unusable avatar', () => {
    const named: User = { id: '3000', username: 'carol_c', global_name: null, avatar: 'https://evil.example/a.png' };
    const article = single({ author: named });
    expect(textOf(article, '.msg-author')).toBe('carol_c');
    expect(article.querySelector('img.msg-avatar')).toBeNull();
    const circle = must(article, 'span.msg-avatar.msg-avatar-fallback');
    expect(circle.textContent).toBe('C');
    expect(circle.getAttribute('aria-hidden')).toBe('true');
    expect(classesOf(circle).some((name) => /^msg-avatar-fallback--[0-5]$/.test(name))).toBe(true);
  });

  it('loads an avatar from the Discord CDN and from an inline image, but nowhere else', () => {
    const cdn: User = { id: '3001', username: 'dave', avatar: 'abcdef' };
    expect(must(single({ author: cdn }), 'img.msg-avatar').getAttribute('src')).toBe('https://cdn.discordapp.com/avatars/3001/abcdef.png?size=80');
    const inline: User = { id: '3002', username: 'erin', avatar: 'data:image/png;base64,AAAA' };
    expect(must(single({ author: inline }), 'img.msg-avatar').getAttribute('src')).toBe('data:image/png;base64,AAAA');
    const html: User = { id: '3003', username: 'frank', avatar: 'data:text/html;base64,AAAA' };
    expect(single({ author: html }).querySelector('img')).toBeNull();
  });

  it('survives a message without an author object', () => {
    const article = single({ author: null as unknown as User });
    expect(textOf(article, '.msg-author')).toBe('Unknown user');
    expect(must(article, 'img.msg-avatar').getAttribute('src')).toBe('https://cdn.discordapp.com/embed/avatars/0.png');
  });

  it('marks edited messages, in the language of the export', () => {
    expect(textOf(single({ edited_timestamp: at(HOUR) }), '.msg-content .msg-edited')).toBe('(edited)');
    expect(textOf(single({ edited_timestamp: at(HOUR) }, 'x', { options: { locale: 'ko' } }), '.msg-edited')).toBe('(수정됨)');
    expect(single({}).querySelector('.msg-edited')).toBeNull();
  });

  it('shows the edit marker of a message that has no text', () => {
    const article = single({ edited_timestamp: at(HOUR) }, '');
    expect(article.querySelector('.md-root')).toBeNull();
    expect(textOf(article, '.msg-content')).toBe('(edited)');
  });

  it('renders no content element for an empty message', () => {
    expect(single({}, '   ').querySelector('.msg-content')).toBeNull();
  });

  it('tags bots and webhooks', () => {
    const bot = single({ author: BOT });
    expect(classesOf(bot)).toContain('msg--app');
    expect(textOf(bot, '.msg-header .msg-tag')).toBe('APP');
    const hook = single({ webhook_id: '99' });
    expect(classesOf(hook)).toContain('msg--app');
    expect(single({}).querySelector('.msg-tag')).toBeNull();
    expect(textOf(single({ author: BOT }, 'x', { options: { locale: 'ko' } }), '.msg-tag')).toBe('앱');
  });

  it('gives the article an accessible name and the time element a machine-readable value', () => {
    const article = single({});
    expect(article.getAttribute('aria-label')).toBe('Alice, Monday, October 5, 2026 at 12:00 PM');
    expect(must(article, 'time.msg-timestamp').getAttribute('datetime')).toBe('2026-10-05T12:00:01.000Z');
  });

  it('prints clock times in the export time zone', () => {
    const article = single({}, 'x', { options: { timeZone: 'Asia/Seoul', locale: 'ko' } });
    expect(textOf(article, 'time.msg-timestamp')).toBe('2026. 10. 05. 오후 9:00');
  });

  it('survives an unparsable timestamp', () => {
    const doc = exported([message(1, 'x', { timestamp: 'yesterday-ish' })]);
    const article = articleOf(doc, 1);
    expect(textOf(article, 'time.msg-timestamp')).toBe('');
    expect(article.querySelector('time[datetime]')).toBeNull();
    expect(doc.querySelector('.msg-day-divider')).toBeNull();
  });
});

describe('grouping and day dividers', () => {
  it('collapses messages of the same author within seven minutes into the first one', () => {
    const doc = exported([
      message(1, 'a'),
      message(2, 'b', { timestamp: at(6 * MINUTE + 59 * 1000) }),
      // Seven minutes after the previous message (not after the first one of the group) starts a new group.
      message(3, 'c', { timestamp: at(13 * MINUTE + 59 * 1000) }),
    ]);
    expect(classesOf(articleOf(doc, 1))).toContain('msg--first');
    const second = articleOf(doc, 2);
    expect(classesOf(second)).toContain('msg--grouped');
    expect(second.querySelector('.msg-avatar, .msg-header')).toBeNull();
    expect(textOf(second, 'time.msg-gutter-time')).toBe('12:06 PM');
    expect(classesOf(articleOf(doc, 3))).toContain('msg--first');
  });

  it('starts a new group for another author', () => {
    const doc = exported([message(1, 'a'), message(2, 'b', { author: BOB })]);
    expect(classesOf(articleOf(doc, 2))).toContain('msg--first');
  });

  it('keeps grouping and day dividers across batch boundaries', () => {
    const messages = [
      message(1, 'a'),
      message(2, 'b'),
      message(3, 'c', { timestamp: at(DAY) }),
      message(4, 'd', { timestamp: at(DAY + 1000) }),
    ];
    const doc = parseDocument(renderExport(batchesOf(messages, 1)));
    expect(all(doc, 'article').map((a) => classesOf(a).includes('msg--grouped'))).toEqual([false, true, false, true]);
    expect(all(doc, '.msg-day-divider__label').map((d) => d.textContent)).toEqual(['October 5, 2026', 'October 6, 2026']);
  });

  it('puts a day divider before the first message of each calendar day in the export zone', () => {
    const messages = [message(1, 'a'), message(2, 'b', { timestamp: at(11 * HOUR + 59 * MINUTE) }), message(3, 'c', { timestamp: at(12 * HOUR) })];
    const utc = exported(messages);
    expect(all(utc, '.msg-day-divider').length).toBe(2);
    const seoul = exported(messages, { options: { timeZone: 'Asia/Seoul', locale: 'ko' } });
    // 12:00 UTC is 21:00 in Seoul: Seoul's day changes at 15:00 UTC, i.e. between the second and the third message.
    expect(all(seoul, '.msg-day-divider__label').map((d) => d.textContent)).toEqual(['2026년 10월 5일', '2026년 10월 6일']);
  });

  it('writes the divider as a separator with an accessible label right before the message', () => {
    const doc = exported([message(1, 'a')]);
    const divider = must(doc, 'main > .msg-day-divider');
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-label')).toBe('October 5, 2026');
    expect(divider.nextElementSibling).toBe(articleOf(doc, 1));
  });

  it('does not group a message with a system message or a reply', () => {
    const doc = exported([
      message(1, 'a'),
      message(2, 'pin', { type: 6 }),
      message(3, 'b'),
      message(4, 'reply', { type: 19, referenced_message: message(1, 'a') }),
    ]);
    expect(classesOf(articleOf(doc, 3))).toContain('msg--first');
    expect(classesOf(articleOf(doc, 4))).toContain('msg--first');
  });
});

describe('markdown content', () => {
  it('renders formatting, code, quotes and spoilers with the shared md-* classes', () => {
    const article = single({}, '**b** *i* __u__ ~~s~~ `code` ||secret||\n> quote\n```js\nlet x = 1;\n```');
    const root = must(article, '.md-root');
    expect(root.querySelector('strong')?.textContent).toBe('b');
    expect(root.querySelector('em')?.textContent).toBe('i');
    expect(root.querySelector('u')?.textContent).toBe('u');
    expect(root.querySelector('s')?.textContent).toBe('s');
    expect(root.querySelector('code.md-code')?.textContent).toBe('code');
    expect(must(root, 'blockquote.md-quote').textContent).toContain('quote');
    expect(must(root, 'pre.md-pre').getAttribute('data-lang')).toBe('js');
    const spoiler = must(root, 'span.md-spoiler');
    expect(spoiler.textContent).toBe('secret');
    expect(spoiler.getAttribute('tabindex')).toBe('0');
    expect(spoiler.hasAttribute('role')).toBe(false);
  });

  it('turns links into external anchors that cannot reach the opener', () => {
    const link = must(single({}, '[docs](https://example.com/a?b=1&c=2) and https://example.org/x'), 'a.md-link');
    expect(link.getAttribute('href')).toBe('https://example.com/a?b=1&c=2');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('resolves mentions with the names of the channel', () => {
    const names = buildNameResolver({ users: { '2000': 'Bob' }, channels: { '5': 'general' }, roles: { '9': 'Mods' } });
    const html = renderExport([[message(1, 'hi <@2000> in <#5> for <@&9> and <@777>')]], context({ names }));
    const mentions = all(parseDocument(html), '.md-mention').map((m) => m.textContent);
    expect(mentions).toEqual(['@Bob', '#general', '@Mods', '@Unknown User']);
  });

  it('loads custom emoji from the CDN and enlarges a message made only of emoji', () => {
    const emoji = single({}, 'hi <:wave:123456789012345678>');
    const img = must<HTMLImageElement>(emoji, 'img.md-emoji');
    expect(img.getAttribute('src')).toBe('https://cdn.discordapp.com/emojis/123456789012345678.png?size=44');
    expect(img.getAttribute('alt')).toBe(':wave:');
    expect(classesOf(img)).not.toContain('md-emoji-jumbo');

    const jumbo = single({}, '<:wave:123456789012345678> 😀');
    expect(classesOf(must(jumbo, 'img.md-emoji'))).toContain('md-emoji-jumbo');
    expect(textOf(jumbo, 'span.md-emoji-jumbo')).toBe('😀');
  });

  it('writes <t:...> markers as time elements in the export zone', () => {
    const time = must(single({}, '<t:1790000000:F>', { options: { timeZone: 'Asia/Seoul' } }), 'time.md-time');
    expect(time.getAttribute('datetime')).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it('keeps line breaks of the message', () => {
    const root = must(single({}, 'one\ntwo'), '.md-root');
    expect(root.querySelectorAll('br').length).toBe(1);
  });
});

describe('replies and forwards', () => {
  const original = message(1, 'the **original** text', { author: BOB });

  it('shows who is replied to and a one-line preview', () => {
    const article = single({ type: 19, referenced_message: original }, 'answer');
    expect(classesOf(article)).toEqual(expect.arrayContaining(['msg--first', 'msg--reply']));
    const reply = must(article, '.msg-reply');
    expect(classesOf(reply)).not.toContain('msg-reply--deleted');
    expect(reply.firstElementChild?.classList.contains('msg-reply__avatar')).toBe(true);
    expect(textOf(reply, '.msg-reply__name')).toBe('Replying to @Bob');
    expect(textOf(reply, '.msg-reply__name .msg-sr-only')).toBe('Replying to ');
    expect(textOf(reply, '.msg-reply__text')).toBe('the original text');
    expect(article.firstElementChild).toBe(reply);
  });

  it('marks a reply whose original is gone', () => {
    const deleted = single({ type: 19, referenced_message: null }, 'answer');
    expect(classesOf(must(deleted, '.msg-reply'))).toContain('msg-reply--deleted');
    expect(textOf(deleted, '.msg-reply__text')).toBe('Original message was deleted');
    expect(deleted.querySelector('.msg-reply__name, .msg-reply__avatar')).toBeNull();
    const unavailable = single({ type: 19 }, 'answer');
    expect(textOf(unavailable, '.msg-reply__text')).toBe('Original message is unavailable');
  });

  it('shows a forwarded message in its own box with a label and the original time', () => {
    const forwarded = single(
      { message_reference: { type: 1 }, message_snapshots: [{ message: { content: 'look at **this**', timestamp: at(-DAY), attachments: [attachment('a.pdf', 'application/pdf')] } }] },
      '',
    );
    expect(classesOf(forwarded)).toContain('msg--forward');
    expect(textOf(forwarded, '.msg-forward-label')).toBe('Forwarded');
    const box = must(forwarded, '.msg-forward');
    expect(must(box, '.msg-content .md-root strong').textContent).toBe('this');
    expect(box.querySelector('.msg-attachment--file')).not.toBeNull();
    expect(must(box, 'time.msg-forward__time').getAttribute('datetime')).toBe(at(-DAY));
  });
});

describe('system messages', () => {
  it.each([
    [7, 'join'],
    [1, 'join'],
    [2, 'leave'],
    [3, 'join'],
    [4, 'neutral'],
    [6, 'pin'],
    [8, 'boost'],
    [11, 'boost'],
    [18, 'neutral'],
    [24, 'neutral'],
  ])('renders type %i with the %s tone', (type, tone) => {
    const article = single({ type, content: type === 4 || type === 18 ? 'new-name' : '' });
    expect(classesOf(article)).toEqual(['msg', 'msg--system']);
    expect(classesOf(must(article, '.msg-system__icon'))).toEqual(['msg-system__icon', `msg-system__icon--${tone}`]);
    expect(article.querySelector('.msg-system__icon svg.msg-icon path')).not.toBeNull();
    expect(article.querySelector('.msg-avatar, .msg-header, .msg-body')).toBeNull();
  });

  it('emphasises the actor and writes the sentence in the export language', () => {
    expect(textOf(single({ type: 6 }), '.msg-system__actor')).toBe('Alice');
    expect(textOf(single({ type: 6 }), '.msg-system__text')).toContain('pinned a message to this channel.');
    const ko = single({ type: 6 }, '', { options: { locale: 'ko' } });
    expect(textOf(ko, '.msg-system__text')).toContain('님이 이 채널에 메시지를 고정했어요.');
  });

  it('includes the time and the data attribute', () => {
    const article = single({ type: 7 });
    expect(must(article, '.msg-system__text time.msg-timestamp').getAttribute('datetime')).toBe('2026-10-05T12:00:01.000Z');
    expect(article.dataset.messageId).toBe(message(1, '').id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------------------------------------------------

describe('attachments', () => {
  it('shows a Discord-hosted image as a lazy picture inside a link to the original', () => {
    const article = single({ attachments: [attachment('cat.png', 'image/png', { width: 800, height: 600, description: 'A cat' })] }, '');
    const frame = must(article, '.msg-attachments > .msg-attachment--image');
    const img = must<HTMLImageElement>(frame, 'a.msg-image-link > img.msg-image');
    expect(img.getAttribute('src')).toBe(`${MEDIA}/cat.png`);
    expect(img.getAttribute('alt')).toBe('A cat');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['400', '300']);
    const link = must(frame, 'a.msg-image-link');
    expect(link.getAttribute('href')).toBe(`${CDN}/cat.png`);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(frame.querySelector('.msg-spoiler-cover')).toBeNull();
  });

  it('uses the file name as the alt text of a picture without description', () => {
    const article = single({ attachments: [attachment('IMG 1.jpg', 'image/jpeg')] }, '');
    expect(must(article, 'img.msg-image').getAttribute('alt')).toBe('IMG 1.jpg');
  });

  it('shows an inline data: image without a link', () => {
    const inline = attachment('x.png', 'image/png', { url: 'data:image/png;base64,AAAA', proxy_url: undefined });
    const article = single({ attachments: [inline] }, '');
    expect(must(article, 'img.msg-image').getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(article.querySelector('a')).toBeNull();
  });

  it('never loads a picture from another host: it becomes a link card', () => {
    const foreign = attachment('cat.png', 'image/png', { url: 'https://example.com/cat.png', proxy_url: undefined });
    const article = single({ attachments: [foreign] }, '');
    expect(article.querySelector('.msg-attachments img, video, audio')).toBeNull();
    const card = must(article, '.msg-attachment--file.msg-file');
    expect(must(card, 'a.msg-file__name').getAttribute('href')).toBe('https://example.com/cat.png');
    expect(textOf(card, '.msg-file__size')).toBe('2 KB');
  });

  it('does not load a plain-http Discord picture either (the CSP would block it)', () => {
    const http = attachment('cat.png', 'image/png', { url: 'http://cdn.discordapp.com/a/cat.png', proxy_url: undefined });
    expect(single({ attachments: [http] }, '').querySelector('.msg-attachments img')).toBeNull();
  });

  it('hides spoiler pictures behind a focusable cover and does not leak their description', () => {
    const spoiler = attachment('SPOILER_secret.png', 'image/png', { description: 'the secret' });
    const frame = must(single({ attachments: [spoiler] }, ''), '.msg-attachment--image');
    expect(classesOf(frame)).toEqual(['msg-attachment', 'msg-attachment--image', 'msg-attachment--spoiler']);
    expect(must(frame, 'img.msg-image').getAttribute('alt')).toBe('');
    const cover = must(frame, '.msg-spoiler-cover');
    expect(cover.getAttribute('tabindex')).toBe('0');
    expect(textOf(cover, '.msg-spoiler-cover__badge')).toBe('Spoiler');
    expect(frame.querySelector('button')).toBeNull();
  });

  it('treats the spoiler flag like the SPOILER_ prefix', () => {
    const flagged = attachment('plain.png', 'image/png', { flags: 8 });
    expect(single({ attachments: [flagged] }, '').querySelector('.msg-attachment--spoiler')).not.toBeNull();
  });

  it('plays Discord-hosted video and audio on request, without preloading anything', () => {
    const article = single({ attachments: [attachment('clip.mp4', 'video/mp4', { width: 1920, height: 1080 }), attachment('note.mp3', 'audio/mpeg')] }, '');
    const video = must<HTMLVideoElement>(article, '.msg-attachment--video > video.msg-video');
    expect(video.getAttribute('src')).toBe(`${MEDIA}/clip.mp4`);
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('preload')).toBe('none');
    expect([video.getAttribute('width'), video.getAttribute('height')]).toEqual(['400', '225']);
    const card = must(article, '.msg-attachment--audio.msg-file');
    const audio = must(card, 'audio.msg-audio');
    expect(audio.getAttribute('src')).toBe(`${MEDIA}/note.mp3`);
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.getAttribute('preload')).toBe('none');
    expect(must(card, 'a.msg-file__name').getAttribute('href')).toBe(`${CDN}/note.mp3`);
  });

  it('turns video and audio from other hosts into link cards', () => {
    const video = attachment('clip.mp4', 'video/mp4', { url: 'https://example.com/clip.mp4', proxy_url: undefined });
    const audio = attachment('note.mp3', 'audio/mpeg', { url: 'https://example.com/note.mp3', proxy_url: undefined });
    const article = single({ attachments: [video, audio] }, '');
    expect(article.querySelector('video, audio')).toBeNull();
    expect(all(article, '.msg-attachment--file').length).toBe(2);
  });

  it('shows other files as cards with name, link and size', () => {
    const doc = attachment('report.pdf', 'application/pdf', { size: 1536 });
    const card = must(single({ attachments: [doc] }, ''), '.msg-attachment--file.msg-file');
    expect(card.querySelector('svg.msg-icon.msg-file__icon')).not.toBeNull();
    expect(textOf(card, 'a.msg-file__name')).toBe('report.pdf');
    expect(textOf(card, '.msg-file__size')).toBe('1.5 KB');
  });

  it('names a file without a name and keeps a file without a usable link as plain text', () => {
    const bare = attachment('', 'application/pdf', { url: 'javascript:alert(1)', proxy_url: undefined });
    const card = must(single({ attachments: [bare] }, ''), '.msg-file');
    expect(card.querySelector('a')).toBeNull();
    expect(textOf(card, 'span.msg-file__name')).toBe('Unnamed file');
  });

  it('formats sizes in the export language', () => {
    expect(textOf(single({ attachments: [attachment('a.bin', 'application/octet-stream', { size: 5 * 1024 * 1024 })] }, '', { options: { locale: 'ko' } }), '.msg-file__size')).toBe('5 MB');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// embeds
// ---------------------------------------------------------------------------------------------------------------------

describe('embeds', () => {
  const rich: Embed = {
    type: 'rich',
    color: 0x5865f2,
    author: { name: 'Status Page', url: 'https://example.com/', icon_url: `${CDN}/author.png` },
    title: 'Scheduled maintenance',
    url: 'https://example.com/status',
    description: 'Tonight **02:00** - 04:00',
    fields: [
      { name: 'A', value: '1', inline: true },
      { name: 'B', value: '2', inline: true },
      { name: 'C', value: '3', inline: true },
      { name: 'D', value: '4', inline: true },
      { name: 'Notes', value: 'All the rest', inline: false },
    ],
    thumbnail: { url: 'https://example.com/t.png', proxy_url: `${MEDIA}/t.png`, width: 400, height: 400 },
    image: { url: 'https://example.com/i.png', proxy_url: `${MEDIA}/i.png`, width: 1600, height: 900 },
    footer: { text: 'Footer text', icon_url: `${CDN}/footer.png` },
    timestamp: '2026-10-05T12:00:00.000Z',
  };

  it('renders every part of a rich embed with the colour bar', () => {
    const embed = must(single({ embeds: [rich] }, ''), '.msg-embeds > .msg-embed.msg-embed--rich');
    expect(embed.getAttribute('style')).toBe('border-left-color:#5865f2');
    expect(must(embed, '.msg-embed__author img.msg-embed__author-icon').getAttribute('src')).toBe(`${CDN}/author.png`);
    expect(must(embed, 'a.msg-embed__author-name').getAttribute('href')).toBe('https://example.com/');
    expect(must(embed, '.msg-embed__title a.msg-embed__title-link').getAttribute('href')).toBe('https://example.com/status');
    expect(must(embed, '.msg-embed__description .md-root strong').textContent).toBe('02:00');
    expect(must(embed, '.msg-embed__thumbnail img.msg-embed__image').getAttribute('src')).toBe(`${MEDIA}/t.png`);
    const main = must(embed, '.msg-embed__media a.msg-embed__media-link img.msg-embed__image');
    expect(main.getAttribute('src')).toBe(`${MEDIA}/i.png`);
    expect([main.getAttribute('width'), main.getAttribute('height')]).toEqual(['400', '225']);
    expect(must(embed, '.msg-embed__footer img.msg-embed__footer-icon').getAttribute('src')).toBe(`${CDN}/footer.png`);
    expect(textOf(embed, '.msg-embed__footer-text')).toBe('Footer text • 10/05/2026 12:00 PM');
    expect(must(embed, '.msg-embed__footer-text time').getAttribute('datetime')).toBe('2026-10-05T12:00:00.000Z');
  });

  it('lays inline fields out three per row, and lets a block field reset the run', () => {
    const embed = must(single({ embeds: [rich] }, ''), '.msg-embed');
    const columns = all(embed, '.msg-embed__field').map((field) => classesOf(field).filter((name) => name !== 'msg-embed__field'));
    expect(columns).toEqual([
      ['msg-embed__field--inline', 'msg-embed__field--col1'],
      ['msg-embed__field--inline', 'msg-embed__field--col2'],
      ['msg-embed__field--inline', 'msg-embed__field--col3'],
      ['msg-embed__field--inline', 'msg-embed__field--col1'],
      [],
    ]);
    expect(textOf(embed, '.msg-embed__field:last-child .msg-embed__field-name')).toBe('Notes');
  });

  it('only loads embed pictures that Discord hosts, preferring its proxy copy', () => {
    const thirdParty: Embed = {
      type: 'article',
      title: 'Article',
      thumbnail: { url: 'https://example.com/t.png' },
      image: { url: 'https://example.com/i.png' },
      author: { name: 'Someone', icon_url: 'https://example.com/a.png' },
      footer: { text: 'F', icon_url: 'https://example.com/f.png' },
    };
    const embed = must(single({ embeds: [thirdParty] }, ''), '.msg-embed');
    expect(embed.querySelector('img')).toBeNull();
    expect(textOf(embed, '.msg-embed__title')).toBe('Article');
    expect(embed.querySelector('.msg-embed__author-icon, .msg-embed__footer-icon')).toBeNull();
  });

  it('shows a bare picture for an image or gif embed without text', () => {
    const image: Embed = { type: 'image', url: 'https://example.com/cat.png', thumbnail: { url: 'https://example.com/cat.png', proxy_url: `${MEDIA}/cat.png`, width: 640, height: 480 } };
    const embed = must(single({ embeds: [image] }, ''), '.msg-embed');
    expect(classesOf(embed)).toEqual(['msg-embed', 'msg-embed--image', 'msg-embed--bare']);
    expect(embed.hasAttribute('style')).toBe(false);
    expect(must(embed, '.msg-embed__media a.msg-embed__media-link').getAttribute('href')).toBe('https://example.com/cat.png');
    expect(embed.querySelector('.msg-embed__play')).toBeNull();
  });

  it('plays a Discord-hosted video embed and shows other videos as a picture with a play badge that links to the source', () => {
    const hosted: Embed = {
      type: 'video',
      title: 'Clip',
      url: 'https://example.com/watch',
      video: { url: `${CDN}/clip.mp4`, width: 1280, height: 720 },
      thumbnail: { url: 'x', proxy_url: `${MEDIA}/poster.png`, width: 1280, height: 720 },
    };
    const player = must<HTMLVideoElement>(single({ embeds: [hosted] }, ''), '.msg-embed__media > video.msg-video');
    expect(player.getAttribute('src')).toBe(`${CDN}/clip.mp4`);
    expect(player.getAttribute('poster')).toBe(`${MEDIA}/poster.png`);
    expect(player.getAttribute('preload')).toBe('none');
    expect(player.hasAttribute('controls')).toBe(true);

    const external: Embed = { ...hosted, video: { url: 'https://example.com/embed/abc' } };
    const embed = must(single({ embeds: [external] }, ''), '.msg-embed');
    expect(embed.querySelector('video')).toBeNull();
    const link = must(embed, '.msg-embed__media a.msg-embed__media-link');
    expect(link.getAttribute('href')).toBe('https://example.com/watch');
    expect(link.getAttribute('aria-label')).toBe('Open video');
    expect(link.querySelector('.msg-embed__play svg.msg-icon')).not.toBeNull();
  });

  it('shows the provider, and leaves out an embed with nothing to show', () => {
    expect(textOf(single({ embeds: [{ type: 'link', provider: { name: 'ExampleTube' } }] }, ''), '.msg-embed__provider')).toBe('ExampleTube');
    const empty = single({ embeds: [{ type: 'rich' }] }, '');
    expect(empty.querySelector('.msg-embed')).toBeNull();
    expect(empty.querySelector('.msg-embeds')?.children.length).toBe(0);
  });

  it('falls back to the rich layout for an unknown embed type and ignores an invalid colour', () => {
    const embed = must(single({ embeds: [{ type: 'weird" onclick="x', title: 'T', color: -5 }] }, ''), '.msg-embed');
    expect(classesOf(embed)).toEqual(['msg-embed', 'msg-embed--rich']);
    expect(embed.hasAttribute('style')).toBe(false);
  });

  it('renders the embeds of a forwarded message too', () => {
    const forwarded = single({ message_reference: { type: 1 }, message_snapshots: [{ message: { content: '', embeds: [{ title: 'Inside' }] } }] }, '');
    expect(textOf(forwarded, '.msg-forward .msg-embed__title')).toBe('Inside');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// reactions, stickers, polls
// ---------------------------------------------------------------------------------------------------------------------

describe('reactions', () => {
  it('shows unicode and custom emoji reactions and tints the ones the user added', () => {
    const article = single({
      reactions: [
        { count: 3, me: true, emoji: { id: null, name: '👍' } },
        { count: 1, emoji: { id: '123456789012345678', name: 'wave' } },
        { count: 2, emoji: { id: 'abc', name: 'odd' } },
      ],
    });
    const group = must(article, '.msg-reactions');
    expect(group.getAttribute('role')).toBe('group');
    const pills = all(group, '.msg-reaction');
    expect(pills.map((pill) => classesOf(pill))).toEqual([['msg-reaction', 'msg-reaction--me'], ['msg-reaction'], ['msg-reaction']]);
    expect(pills[0]!.getAttribute('aria-label')).toBe('👍, 3 reactions, including you');
    expect(textOf(pills[0]!, '.msg-reaction__emoji')).toBe('👍');
    expect(textOf(pills[0]!, '.msg-reaction__count')).toBe('3');
    expect(must(pills[1]!, 'img.msg-reaction__img').getAttribute('src')).toBe('https://cdn.discordapp.com/emojis/123456789012345678.png?size=32');
    expect(textOf(pills[2]!, '.msg-reaction__emoji--text')).toBe(':odd:');
    expect(pills[2]!.querySelector('img')).toBeNull();
  });

  it('writes no reaction bar without reactions', () => {
    expect(single({ reactions: [] }).querySelector('.msg-reactions')).toBeNull();
  });
});

describe('stickers', () => {
  it('shows a sticker as a picture from Discord and a Lottie sticker by name', () => {
    const article = single({
      sticker_items: [
        { id: '123456789012345678', name: 'wave', format_type: 1 },
        { id: '123456789012345679', name: 'cat', format_type: 3 },
        { id: '123456789012345680', name: '', format_type: 3 },
      ],
    }, '');
    const stickers = all(article, '.msg-stickers > .msg-sticker');
    const img = must<HTMLImageElement>(stickers[0]!, 'img.msg-sticker__image');
    expect(img.getAttribute('src')).toBe('https://media.discordapp.net/stickers/123456789012345678.png?size=160');
    expect(img.getAttribute('alt')).toBe('wave');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['160', '160']);
    expect(textOf(stickers[1]!, '.msg-sticker__name')).toBe('cat');
    expect(textOf(stickers[2]!, '.msg-sticker__name')).toBe('Sticker');
  });
});

describe('polls', () => {
  const poll = {
    question: { text: 'Lunch?' },
    answers: [
      { answer_id: 1, poll_media: { text: 'Noodles', emoji: { id: null, name: '🍜' } } },
      { answer_id: 2, poll_media: { text: 'Salad' } },
    ],
    allow_multiselect: true,
    results: { is_finalized: false, answer_counts: [{ id: 1, count: 3 }, { id: 2, count: 1 }] },
  };

  it('shows question, hint, answers with votes and bars, and the total', () => {
    const box = must(single({ poll }, ''), '.msg-poll');
    expect(classesOf(box)).toEqual(['msg-poll']);
    expect(textOf(box, '.msg-poll__question')).toBe('Lunch?');
    expect(textOf(box, '.msg-poll__hint')).toBe('Select one or more answers');
    const answers = all(box, 'li.msg-poll__answer');
    expect(answers.map((a) => textOf(a, '.msg-poll__text'))).toEqual(['Noodles', 'Salad']);
    expect(textOf(answers[0]!, '.msg-poll__emoji')).toBe('🍜');
    expect(textOf(answers[0]!, '.msg-poll__votes')).toBe('3 votes · 75%');
    const bar = must(answers[1]!, 'progress.msg-poll__bar');
    expect([bar.getAttribute('max'), bar.getAttribute('value')]).toEqual(['4', '1']);
    expect(textOf(box, '.msg-poll__footer')).toBe('4 votes');
    expect(box.querySelector('.msg-poll__answer--winner')).toBeNull();
  });

  it('marks the winner of a closed poll', () => {
    const closed = { ...poll, results: { is_finalized: true, answer_counts: poll.results.answer_counts } };
    const box = must(single({ poll: closed }, ''), '.msg-poll');
    expect(classesOf(box)).toEqual(['msg-poll', 'msg-poll--closed']);
    expect(box.querySelector('.msg-poll__hint')).toBeNull();
    expect(all(box, '.msg-poll__answer--winner').map((a) => textOf(a, '.msg-poll__text'))).toEqual(['Noodles']);
    expect(textOf(box, '.msg-poll__footer')).toBe('4 votes · Poll closed');
  });

  it('shows answers without bars when the API sent no results', () => {
    const box = must(single({ poll: { ...poll, results: undefined } }, ''), '.msg-poll');
    expect(box.querySelector('progress, .msg-poll__votes, .msg-poll__footer')).toBeNull();
    expect(all(box, 'li').length).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the mock showcase channel
// ---------------------------------------------------------------------------------------------------------------------

describe('showcase channel', () => {
  it('writes every message of the mock showcase channel once, in order, as a direct child of main', async () => {
    const messages = await showcaseMessages();
    const html = renderExport([messages], context({ names: namesFor(messages) }));
    const doc = parseDocument(html);
    expect(messages.length).toBeGreaterThan(100);
    const children = all(doc, 'main > *');
    expect(children.every((child) => child.tagName === 'ARTICLE' || classesOf(child).includes('msg-day-divider'))).toBe(true);
    expect(all(doc, 'main > article').map((a) => a.dataset.messageId)).toEqual(messages.map((m) => m.id));
    expect(all(doc, '[data-message-id]').length).toBe(messages.length);
    expect(textOf(doc, 'footer .dce-meta dd')).toBe(String(messages.length));
  });

  it.each([
    ['en', 'dark'],
    ['ko', 'light'],
  ] as const)('is well-formed (%s, %s theme)', async (locale, htmlTheme) => {
    const messages = await showcaseMessages();
    const html = renderExport([messages], context({ names: namesFor(messages), options: { locale, htmlTheme, timeZone: 'Asia/Seoul' } }));
    expect(tagProblems(html)).toEqual([]);
  });

  it('uses every kind of block the message view has', async () => {
    const messages = await showcaseMessages();
    const doc = parseDocument(renderExport([messages], context({ names: namesFor(messages) })));
    for (const selector of [
      '.msg-day-divider',
      '.msg--grouped',
      '.msg-reply',
      '.msg-reply--deleted',
      '.msg-forward-label',
      '.msg-forward',
      '.msg-tag',
      '.msg-edited',
      '.msg-attachment--image',
      '.msg-attachment--video',
      '.msg-attachment--audio',
      '.msg-attachment--file',
      '.msg-attachment--spoiler',
      '.msg-embed',
      '.msg-embed__fields',
      '.msg-sticker',
      '.msg-poll',
      '.msg-poll--closed',
      '.msg-reaction',
      '.msg-reaction--me',
      '.msg--system',
      '.md-spoiler',
      '.md-mention',
      '.md-emoji-jumbo',
    ]) {
      expect(doc.querySelector(selector), selector).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------------------------------------------------

describe('writer protocol', () => {
  it('returns the document head and header from start(), one string per batch from write(), and the closing tags from end()', () => {
    const writer = htmlFormat.createWriter(context());
    const start = writer.start();
    expect(start.every((chunk) => typeof chunk === 'string')).toBe(true);
    expect(asText(start)).toMatch(/<main>\n$/);
    expect(asText(start)).toContain('<h1 class="dce-header__title">My Server</h1>');

    const written = writer.write([message(1, 'a'), message(2, 'b'), message(3, 'c')]);
    expect(written).toHaveLength(1);
    expect(typeof written[0]).toBe('string');

    expect(writer.write([])).toEqual([]);

    const end = writer.end({ messageCount: 3, firstTimestamp: at(1000), lastTimestamp: at(3000) });
    expect(end.every((chunk) => typeof chunk === 'string')).toBe(true);
    expect(asText(end).startsWith('</main>')).toBe(true);
    expect(asText(end).endsWith('</html>\n')).toBe(true);
  });

  it.each([1, 2, 7, 50, 1000])('produces the same file whatever the batch size (%i)', async (size) => {
    const messages = await showcaseMessages();
    const ctx = context({ names: namesFor(messages), options: { timeZone: 'Asia/Seoul' } });
    const whole = renderExport([messages], ctx);
    expect(renderExport(batchesOf(messages, size), ctx)).toBe(whole);
  });

  it('skips entries that are not objects without losing track of the previous message', () => {
    const messages = [message(1, 'a'), null as unknown as Message, message(2, 'b')];
    const doc = parseDocument(renderExport([messages], context(), { messageCount: 2 }));
    expect(all(doc, 'article').length).toBe(2);
    expect(classesOf(articleOf(doc, 2))).toContain('msg--grouped');
  });

  it('is described by htmlFormat', () => {
    expect(htmlFormat).toMatchObject({ id: 'html', label: 'HTML (.html)', extension: 'html', mime: 'text/html;charset=utf-8' });
  });

  it('exports a complete channel through exportChat', async () => {
    const result = await exportMock(MOCK_IDS.showcaseChannel, 'html', { ctx: { timeZone: 'UTC', now: () => EXPORTED_AT } });
    expect(result).toMatchObject({ status: 'done', error: null });
    expect(result.outputs).toHaveLength(1);
    const [output] = result.outputs;
    expect(output!.path).toMatch(/feature-showcase \(2026-10-06\)\.html$/);
    expect(output!.mime).toBe('text/html;charset=utf-8');
    const html = outputText(output!);
    const doc = parseDocument(html);
    expect(tagProblems(html)).toEqual([]);
    expect(all(doc, 'main > article').length).toBe(result.messageCount);
    expect(textOf(doc, 'footer .dce-meta dd')).toBe(String(result.messageCount));
    expect(textOf(doc, 'h1.dce-header__title')).toBe('개발자 라운지');
    expect(all(doc, 'header .dce-meta dd').at(-2)?.textContent).toBe('2026-10-06 12:34:56 (UTC)');
  });
});

describe('performance', () => {
  it('writes 20,000 messages in batches in time proportional to their number', () => {
    const authors: User[] = [ALICE, BOB, BOT];
    const names = buildNameResolver({ users: { '2000': 'Bob' } });
    const { size, articles } = expectLinearScaling(
      (total) => {
        const writer = htmlFormat.createWriter(context({ names }));
        let bytes = 0;
        let count = 0;
        for (const chunk of writer.start()) bytes += chunk.length;
        for (let from = 0; from < total; from += 100) {
          const batch: Message[] = [];
          for (let n = from; n < Math.min(total, from + 100); n += 1) {
            const author = authors[n % 3]!;
            batch.push(
              message(n, n % 5 === 0 ? `**message ${n}** for <@2000>, see https://example.com/${n} :tada:` : `plain message number ${n}`, {
                author,
                timestamp: at(n * 20 * 1000),
                ...(n % 11 === 0 ? { type: 19, referenced_message: message(n - 1, 'the original') } : {}),
                ...(n % 17 === 0 ? { reactions: [{ count: 2, emoji: { id: null, name: '👍' } }] } : {}),
              }),
            );
          }
          for (const chunk of writer.write(batch)) {
            bytes += chunk.length;
            count += (chunk as string).split('<article ').length - 1;
          }
        }
        for (const chunk of writer.end({ messageCount: total, firstTimestamp: at(0), lastTimestamp: at(total * 20 * 1000) })) bytes += chunk.length;
        return { size: bytes, articles: count };
      },
      { small: 2_000, large: 20_000 },
    );
    expect(articles).toBe(20_000);
    expect(size).toBeGreaterThan(20_000 * 200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// what may be loaded
// ---------------------------------------------------------------------------------------------------------------------

describe('loadable media', () => {
  it.each([
    ['https://cdn.discordapp.com/attachments/1/2/a.png', 'https://cdn.discordapp.com/attachments/1/2/a.png'],
    ['https://media.discordapp.net/a.png?x=1&y=2', 'https://media.discordapp.net/a.png?x=1&y=2'],
    ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
    ['data:image/svg+xml;base64,AAAA', 'data:image/svg+xml;base64,AAAA'],
    ['http://cdn.discordapp.com/a.png', null],
    ['https://example.com/a.png', null],
    ['https://cdn.discordapp.com.evil.example/a.png', null],
    ['https://cdn.discordapp.com@evil.example/a.png', null],
    ['data:text/html;base64,AAAA', null],
    ['javascript:alert(1)', null],
    ['file:///etc/passwd', null],
    ['', null],
    [null, null],
  ])('loads the picture %s as %s', (url, expected) => {
    expect(loadableImage(url)).toBe(expected);
  });

  it.each([
    ['https://cdn.discordapp.com/attachments/1/2/a.mp4', 'https://cdn.discordapp.com/attachments/1/2/a.mp4'],
    ['http://cdn.discordapp.com/a.mp4', null],
    ['https://example.com/a.mp4', null],
    ['data:image/png;base64,AAAA', null],
    ['data:video/mp4;base64,AAAA', null],
    ['javascript:alert(1)', null],
    [undefined, null],
  ])('plays %s as %s', (url, expected) => {
    expect(loadableMedia(url)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// style block
// ---------------------------------------------------------------------------------------------------------------------

/** Declarations of the first rule whose selector is exactly `selector`, as name -> value. */
function customProperties(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector}{`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  const body = css.slice(start + selector.length + 1, css.indexOf('}', start));
  const props = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):([^;]+)/g)) props.set(match[1]!, match[2]!.trim());
  return props;
}

const squash = (css: string): string => css.replace(/\/\*[^]*?\*\//g, '').replace(/\s+/g, '');

describe('style block', () => {
  const css = exportStyles();
  const dark = customProperties(css, ':root');
  const light = customProperties(css, ":root[data-theme='light']");

  it('contains markdown.css and message.css (comments and layout whitespace aside)', () => {
    for (const name of ['markdown', 'message']) {
      expect(squash(css)).toContain(squash(readFileSync(repoFile(`src/lib/export/formats/html/${name}.css`), 'utf8')));
    }
  });

  it('is plain CSS that cannot close its own element or open a comment', () => {
    expect(css).not.toMatch(/<\/?style|<!--|-->|<\//i);
    expect(css.split('{').length).toBe(css.split('}').length);
    expect(css).not.toMatch(/@import|url\(|expression\(|javascript:/i);
  });

  it('defines the dark palette with exactly the values of theme.css', () => {
    const theme = new Map<string, string>();
    for (const match of themeCss.replace(/\/\*[^]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      theme.set(match[1]!, match[2]!.trim().replace(/\s+/g, ' '));
    }
    expect(theme.size).toBeGreaterThan(40);
    expect(dark.size).toBeGreaterThan(15);
    for (const [name, value] of dark) expect(value, name).toBe(theme.get(name));
  });

  it('defines the light palette of the spec, and every token that the dark theme defines', () => {
    expect(Object.fromEntries(light)).toMatchObject({
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f2f3f5',
      '--bg-tertiary': '#e3e5e8',
      '--text-normal': '#313338',
      '--text-header': '#060607',
      '--text-muted': '#5c5e66',
      '--channel-icon': '#5c5e66',
      '--divider': '#e1e2e4',
      '--brand': '#5865f2',
      '--link': '#006ce7',
      '--embed-bg': '#f2f3f5',
      '--bg-message-hover': '#f7f7f8',
      '--code-bg': '#f2f3f5',
    });
    expect([...dark.keys()].filter((name) => !light.has(name) && name !== '--font-sans')).toEqual([]);
    expect([...dark.keys()].sort()).toEqual([...exportedTokenNames()].sort());
  });

  it('defines every custom property that the stylesheet reads (except the local --msg-* ones)', () => {
    const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!));
    for (const name of used) {
      if (name.startsWith('--msg-')) continue;
      expect(dark.has(name), `${name} in the dark theme`).toBe(true);
    }
  });

  it('parses into as many rules as it has top-level blocks, so no syntax error swallowed a rule', () => {
    let depth = 0;
    let blocks = 0;
    for (const ch of css) {
      if (ch === '{') {
        if (depth === 0) blocks += 1;
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      }
    }
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    expect(depth).toBe(0);
    expect(style.sheet?.cssRules.length).toBe(blocks);
    const selectors = Array.from(style.sheet?.cssRules ?? []).map((rule) => (rule as CSSStyleRule).selectorText);
    expect(selectors).toEqual(expect.arrayContaining([':root', ":root[data-theme='light']", '.dce-header', '.msg-day-divider', '.md-spoiler', '.msg']));
    style.remove();
  });

  it('lets hover and focus reveal spoilers without script', () => {
    const squashed = squash(css);
    expect(squashed).toContain('.msg-attachment--spoiler:is(:hover,:focus-within).msg-image{');
    expect(squashed).toContain('.md-spoiler:is(.md-spoiler-revealed,:not([role=\'button\']):is(:hover,:focus,:focus-within))');
  });

  it('is only built once', () => {
    expect(exportStyles()).toBe(css);
  });
});

describe('document independence', () => {
  it('does not depend on the app: no module state leaks between two writers', () => {
    const first = renderExport([[message(1, 'one')]]);
    const second = renderExport([[message(1, 'one')]], context({ options: { htmlTheme: 'light' } }));
    expect(second).not.toBe(first);
    expect(renderExport([[message(1, 'one')]])).toBe(first);
  });

  it('keeps the previous message of one writer out of another one', () => {
    const a = htmlFormat.createWriter(context());
    const b = htmlFormat.createWriter(context());
    a.write([message(1, 'x')]);
    const html = asText(b.write([message(2, 'y')]));
    expect(html).toContain('msg--first');
    expect(html).toContain('msg-day-divider');
  });
});
