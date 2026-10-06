// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { context, message, parseDocument, renderExport, tagProblems, at, SECOND } from './htmlTestKit';
import type { Attachment, Embed, Message, User } from '../../../../src/lib/discord/types';
import { exportStyles } from '../../../../src/lib/export/formats/html/css';
import type { WriterOptions, ExportTarget } from '../../../../src/lib/export/types';
import type { NameResolver } from '../../../../src/lib/markdown/types';

/**
 * Everything Discord sends is attacker-controlled. The export is opened straight from disk by people who trust it,
 * so these tests throw hostile text at every place where data ends up in the file and then look at the parsed DOM:
 * no script, no event handler, no unexpected attribute, no URL that is not http(s)/mailto in a link and not Discord
 * (or an inline image) in a media element, a CSP that cannot be changed from the inside, and a head that the data
 * cannot reach.
 */

const CSP =
  "default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";

/** The policy of a file with saved attachment copies: pictures and media may also come from the file's own folder. */
const CSP_LOCAL =
  "default-src 'none'; img-src 'self' file: https: data:; media-src 'self' file: https:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";

const SCRIPT = '<script>alert(1)</script>';
const IMG = '<img src=x onerror=alert(1)>';
const BREAKOUT = `"'><script>alert(1)</script>`;
/** Stays inside one attribute value only if the quote is escaped: otherwise `onerror` and `data-x` become attributes. */
const ATTRIBUTE_BREAKOUT = `x" onerror="alert(1)" data-x="`;
const CLOSERS = `</title></style></head></body></html>`;

/** Every attribute name that the export legitimately writes (lower case). Anything else means that data became markup. */
const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'class',
  'lang',
  'data-theme',
  'charset',
  'name',
  'content',
  'http-equiv',
  'href',
  'target',
  'rel',
  'title',
  'src',
  'alt',
  'width',
  'height',
  'loading',
  'decoding',
  'dir',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-level',
  'datetime',
  'data-message-id',
  'data-lang',
  'draggable',
  'tabindex',
  'controls',
  'preload',
  'playsinline',
  'poster',
  'start',
  'max',
  'value',
  'viewbox',
  'focusable',
  'fill',
  'fill-rule',
  'd',
  'style',
]);

const DISCORD_HOST = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discordcdn\.com)$/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i;

function isDiscordHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && DISCORD_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * A reference to a saved copy: a relative path (no scheme, no leading slash, no dot segments) whose segments consist of
 * letters, digits, marks and `-_.~` or percent escapes, i.e. nothing that could end an attribute or change the location.
 */
function isLocalReference(value: string): boolean {
  if (value === '' || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && /^(?:[\p{L}\p{N}\p{M}\-_.~]|%[0-9A-F]{2})+$/u.test(segment));
}

/**
 * Fails with a readable message for the first thing in the document that a hostile message could have smuggled in.
 * `local`: the file was written with saved attachment copies, so its policy is the wider one and pictures / media / links
 * may also be local references.
 */
function violations(html: string, local = false): string[] {
  const found: string[] = [];
  const doc = parseDocument(html);

  for (const problem of tagProblems(html)) found.push(`markup: ${problem}`);
  if (/<script/i.test(html)) found.push('raw "<script" in the output');
  if (doc.querySelectorAll('script, iframe, frame, object, embed, applet, form, input, button, textarea, select, link, base, use, foreignObject, noscript, template').length > 0) {
    found.push('forbidden element');
  }
  if (doc.querySelectorAll('a a').length > 0) found.push('nested anchors');

  const csp = doc.querySelectorAll('meta[http-equiv]');
  if (csp.length !== 1 || csp[0]!.getAttribute('http-equiv') !== 'Content-Security-Policy' || csp[0]!.getAttribute('content') !== (local ? CSP_LOCAL : CSP)) {
    found.push('CSP meta is not exactly the expected one');
  }
  if (doc.querySelectorAll('style').length !== 1 || doc.querySelector('style')!.textContent !== exportStyles()) found.push('style block changed');
  const head = Array.from(doc.head.children).map((child) => child.tagName.toLowerCase());
  if (head.join(',') !== 'meta,meta,meta,meta,meta,meta,title,style') found.push(`head children: ${head.join(',')}`);
  if (Array.from(doc.body.children).map((child) => child.tagName.toLowerCase()).join(',') !== 'div') found.push('body children');
  if (Array.from(doc.querySelector('.dce-page')!.children).map((child) => child.tagName.toLowerCase()).join(',') !== 'header,main,footer') {
    found.push('page children');
  }
  for (const child of Array.from(doc.querySelectorAll('main > *'))) {
    if (!(child.tagName === 'ARTICLE' && child.classList.contains('msg')) && !child.classList.contains('msg-day-divider') && !child.classList.contains('dce-empty')) {
      found.push(`unexpected child of main: ${child.tagName}.${child.className}`);
    }
  }

  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!ALLOWED_ATTRIBUTES.has(name)) found.push(`attribute ${name} on <${element.tagName.toLowerCase()}>`);
      if (name.startsWith('on')) found.push(`event handler ${name}`);
      if (name === 'style' && !(element.classList.contains('msg-embed') && /^border-left-color:#[0-9a-f]{6}$/.test(attribute.value))) {
        found.push(`style attribute: ${attribute.value}`);
      }
      if (name === 'target' && attribute.value !== '_blank') found.push(`target ${attribute.value}`);
    }
  }

  for (const anchor of Array.from(doc.querySelectorAll('a'))) {
    const href = anchor.getAttribute('href');
    if (href === null) continue;
    if (local && isLocalReference(href)) {
      if (anchor.getAttribute('target') !== '_blank' || anchor.getAttribute('rel') !== 'noopener noreferrer nofollow') found.push(`local anchor without target/rel: ${href.slice(0, 60)}`);
      continue;
    }
    let protocol = '';
    try {
      protocol = new URL(href).protocol;
    } catch {
      found.push(`unparsable href: ${href}`);
    }
    if (!['http:', 'https:', 'mailto:'].includes(protocol)) found.push(`href with scheme ${protocol}: ${href.slice(0, 60)}`);
    if (anchor.getAttribute('target') !== '_blank' || anchor.getAttribute('rel') !== 'noopener noreferrer nofollow') {
      found.push(`anchor without target/rel: ${href.slice(0, 60)}`);
    }
  }
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!DATA_IMAGE.test(src) && !isDiscordHttps(src) && !(local && isLocalReference(src))) found.push(`img src: ${src.slice(0, 60)}`);
  }
  for (const player of Array.from(doc.querySelectorAll('video, audio'))) {
    const src = player.getAttribute('src') ?? '';
    if (!isDiscordHttps(src) && !(local && isLocalReference(src))) found.push(`${player.tagName.toLowerCase()} src: ${src.slice(0, 60)}`);
    if (player.getAttribute('preload') !== 'none' || !player.hasAttribute('controls')) found.push('player without controls / preload=none');
    const poster = player.getAttribute('poster');
    if (poster !== null && !DATA_IMAGE.test(poster) && !isDiscordHttps(poster)) found.push(`poster: ${poster.slice(0, 60)}`);
  }
  // Control and bidi-override characters are removed, so nothing can reorder or hide what a reader sees.
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(html)) found.push('control or bidi character in the output');
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// the corpus
// ---------------------------------------------------------------------------------------------------------------------

const HOSTILE_NAMES: NameResolver = {
  user: () => `${SCRIPT}${BREAKOUT}`,
  channel: () => `${IMG}${CLOSERS}`,
  role: () => `"onmouseover="alert(1)${SCRIPT}`,
};

const HOSTILE_TARGET: ExportTarget = {
  channelId: '555',
  kind: 'text',
  channelName: `${CLOSERS}${SCRIPT}${BREAKOUT}${IMG}`,
  guildId: '777',
  guildName: `${CLOSERS}${SCRIPT}${BREAKOUT}`,
  categoryName: `${CLOSERS}${IMG}`,
  parentChannelName: null,
  topic: `${CLOSERS}${SCRIPT}\u0000\u202e${IMG}`,
  iconUrl: 'javascript:alert(1)',
};

function evilUser(n: number, avatar: string | null): User {
  return { id: String(8000 + n), username: `u${n}${BREAKOUT}`, global_name: `${IMG}${SCRIPT}`, avatar, discriminator: '0' };
}

const AVATARS = [
  null,
  'javascript:alert(1)',
  '"onerror="alert(1)',
  'https://evil.example/avatar.png',
  'http://cdn.discordapp.com/avatars/1/a.png',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml,<svg onload=alert(1)>',
  'file:///etc/passwd',
  'a/../../b?"><script>',
];

const HOSTILE_CONTENT = [
  SCRIPT,
  IMG,
  `"><svg onload=alert(1)>`,
  '[click](javascript:alert(1))',
  '[click](  javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](java\tscript:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[file](file:///C:/Windows/win.ini)',
  '[vb](vbscript:msgbox(1))',
  '[ok](mailto:someone@example.com) <mailto:evil@example.com>',
  '<a href="javascript:alert(1)">x</a>',
  'javascript:alert(1) https://example.com/"onmouseover="alert(1)',
  '[a](https://example.com/" onfocus="alert(1)" x=")',
  '[a](<https://example.com/ onclick=alert(1)>)',
  `${CLOSERS}${SCRIPT}`,
  `||${SCRIPT}||`,
  `\`\`\`"><script>alert(1)</script>\n</pre>${SCRIPT}\`\`\``,
  '```js" onclick="alert(1)\ncode\n```',
  `# ${IMG}`,
  `> ${SCRIPT}`,
  `- ${SCRIPT}\n- ${IMG}`,
  '<:x" onerror="alert(1):123456789012345678>',
  `<a:y"${SCRIPT}:123456789012345678>`,
  '<@123> <#456> <@&789> <@!123>',
  '<t:99999999999999999999:R> <t:1:"><script>> <t:-1:F>',
  `${'A'.repeat(10_000)}`,
  `${'ab '.repeat(3000)}`,
  'a\u0000b\u0007c\u202ed\u2028e\u0085f\u200bg',
  `\u202e${SCRIPT}\u202c`,
  '<!-- --> <![CDATA[ ]]> <?xml ?> &lt;script&gt; &#60;script&#62; &amp; &#x3C;',
  'javascript&colon;alert(1) &#106;avascript:alert(1)',
  '@everyone @here <@&1> <#1>',
  '`<script>` ``</script>`` `',
  '*'.repeat(500) + '_'.repeat(500) + '~'.repeat(500) + '|'.repeat(500),
  '['.repeat(300) + '](' + 'x'.repeat(300),
  '> '.repeat(200) + 'deep',
  '||'.repeat(300),
];

function hostileAttachments(): Attachment[] {
  const base = { id: '9', size: 10, url: 'https://cdn.discordapp.com/a/b.png' };
  return [
    { ...base, filename: `"><script>alert(1)</script>.png`, content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/%22%3E.png' },
    { ...base, filename: 'onerror=alert(1).png', content_type: 'image/png', description: `${BREAKOUT}`, width: 1e9, height: 'x' as unknown as number },
    { ...base, filename: 'a.png', content_type: 'image/png', url: 'javascript:alert(1)', proxy_url: 'javascript:alert(1)' },
    { ...base, filename: 'b.png', content_type: 'image/png', url: 'file:///etc/passwd', proxy_url: undefined },
    { ...base, filename: 'c.png', content_type: 'image/png', url: 'data:text/html,<script>alert(1)</script>', proxy_url: undefined },
    { ...base, filename: 'd.png', content_type: 'image/png', url: 'https://evil.example/track.png', proxy_url: undefined },
    { ...base, filename: 'e.png', content_type: 'image/png', url: 'https://evil.example/x.png', proxy_url: 'https://cdn.discordapp.com.evil.example/x.png' },
    { ...base, filename: 'f.png', content_type: 'image/png', url: 'http://cdn.discordapp.com/x.png', proxy_url: undefined },
    { ...base, filename: 'g.png', content_type: 'image/png', url: 'data:image/svg+xml,<svg onload=alert(1)>', proxy_url: undefined },
    { ...base, filename: 'SPOILER_h.png', content_type: 'image/png', description: SCRIPT },
    { ...base, filename: 'v.mp4', content_type: 'video/mp4', url: 'https://evil.example/v.mp4', proxy_url: undefined },
    { ...base, filename: 'w.mp4', content_type: 'video/mp4', url: 'data:video/mp4;base64,AAAA', proxy_url: undefined },
    { ...base, filename: 'x.mp3', content_type: 'audio/mpeg', url: 'javascript:alert(1)', proxy_url: undefined },
    { ...base, filename: `y".mp4`, content_type: 'video/mp4', url: 'https://cdn.discordapp.com/v.mp4?a="b"&c=<d>' },
    { ...base, filename: SCRIPT, content_type: 'application/pdf', url: 'https://example.com/"onclick="alert(1)' },
    { ...base, filename: '', content_type: undefined, size: Number.NaN },
    { ...base, filename: '..\\..\\evil.exe', content_type: 'application/octet-stream', size: -5 },
    { ...base, filename: 'z', size: 1e309 },
    null as unknown as Attachment,
    'text' as unknown as Attachment,
  ];
}

function hostileEmbeds(): Embed[] {
  const media = (url: string) => ({ url, proxy_url: url, width: 100, height: 100 });
  return [
    {
      type: 'rich',
      title: `${SCRIPT}${BREAKOUT}`,
      url: 'javascript:alert(1)',
      description: `${IMG} [x](javascript:alert(1)) ${SCRIPT}`,
      color: 0xff0000,
      author: { name: SCRIPT, url: 'javascript:alert(1)', icon_url: 'javascript:alert(1)' },
      footer: { text: IMG, icon_url: 'https://evil.example/f.png' },
      provider: { name: BREAKOUT, url: 'javascript:alert(1)' },
      fields: [
        { name: SCRIPT, value: IMG, inline: true },
        { name: BREAKOUT, value: '[x](data:text/html,<script>alert(1)</script>)', inline: true },
        { name: '', value: '' },
        null as unknown as { name: string; value: string },
      ],
      timestamp: '"><script>alert(1)</script>',
      image: media('https://evil.example/track.png'),
      thumbnail: media('data:text/html,<script>alert(1)</script>'),
    },
    // Text that ends up in attributes (the picture's alt, the player's aria-label) next to pictures that really load.
    { type: 'rich', title: ATTRIBUTE_BREAKOUT, image: media('https://media.discordapp.net/a.png'), thumbnail: media('https://media.discordapp.net/t.png') },
    { type: 'rich', provider: { name: ATTRIBUTE_BREAKOUT }, thumbnail: media('https://media.discordapp.net/t.png') },
    { type: 'rich', title: BREAKOUT, url: 'https://example.com/x', image: media('https://cdn.discordapp.com/a.png') },
    { type: 'image', title: ATTRIBUTE_BREAKOUT, url: 'https://example.com/x', image: media('https://media.discordapp.net/i.png') },
    { type: 'video', title: ATTRIBUTE_BREAKOUT, video: media('https://cdn.discordapp.com/v.mp4'), thumbnail: media('https://media.discordapp.net/p.png') },
    { type: 'video', title: ATTRIBUTE_BREAKOUT, url: 'https://example.com/v', video: media('https://evil.example/v.mp4'), image: media('https://media.discordapp.net/p.png') },
    { type: 'video', title: 'v', url: 'https://example.com/v', video: media('javascript:alert(1)'), thumbnail: media('https://cdn.discordapp.com/t.png') },
    { type: 'video', title: 'v', video: media('https://evil.example/v.mp4'), image: media('https://media.discordapp.net/i.png?x="y"') },
    { type: 'video', title: 'v', video: media('http://cdn.discordapp.com/v.mp4') },
    { type: 'gifv', video: media('file:///etc/passwd'), thumbnail: media('https://cdn.discordapp.com/x.gif') },
    { type: 'image', url: 'https://example.com/"onclick="alert(1)', thumbnail: media('https://cdn.discordapp.com/x.png') },
    { type: `rich" onclick="alert(1)`, title: 'T', color: 0x1000000 },
    { type: 'rich', title: 'T', color: Number.NaN },
    { type: 'rich', title: 'T', color: '#ff0000' as unknown as number },
    { type: 'rich', title: 'T', color: -1 },
    { type: 'rich', title: 'T', color: 1.5 },
    { type: 'rich', title: 'T', color: 255 },
    null as unknown as Embed,
    [] as unknown as Embed,
  ];
}

function hostileMessages(): Message[] {
  const messages: Message[] = [];
  let n = 0;
  const add = (extra: Partial<Message>, content = '', gap = 20): void => {
    n += 1;
    messages.push(message(n, content, { author: evilUser(n % 9, AVATARS[n % AVATARS.length] ?? null), timestamp: at(n * gap * SECOND), ...extra }));
  };

  for (const content of HOSTILE_CONTENT) add({}, content);

  add({ attachments: hostileAttachments() });
  add({ embeds: hostileEmbeds() });
  add({ message_reference: { type: 1 }, message_snapshots: [{ message: { content: `${IMG}${SCRIPT}`, attachments: hostileAttachments(), embeds: hostileEmbeds(), timestamp: '"><script>' } }] });
  add({ message_snapshots: [{ message: null as never }, null as never] });
  add({
    sticker_items: [
      { id: '"><script>', name: SCRIPT, format_type: 1 },
      { id: '123456789012345678', name: `"${IMG}`, format_type: 4 },
      { id: '123456789012345679', name: '', format_type: 'x' as unknown as number },
      { id: 123 as unknown as string, name: 'n', format_type: 1 },
    ],
  });
  add({
    reactions: [
      { count: 1, emoji: { id: null, name: SCRIPT } },
      { count: 2, me: true, emoji: { id: '"><script>', name: BREAKOUT } },
      { count: 3, emoji: { id: '123456789012345678', name: `"${IMG}`, animated: true } },
      { count: Number.NaN, emoji: { id: null, name: null } },
      { count: 1 } as never,
      null as never,
    ],
  });
  add({
    poll: {
      question: { text: `${SCRIPT}${BREAKOUT}` },
      answers: [
        { answer_id: 1, poll_media: { text: IMG, emoji: { id: '1', name: `"${SCRIPT}` } } },
        { answer_id: 2, poll_media: { text: BREAKOUT, emoji: { id: null, name: SCRIPT } } },
        null as never,
      ],
      allow_multiselect: true,
      results: { is_finalized: true, answer_counts: [{ id: 1, count: 1e308 }, { id: 2, count: -3 }, null as never] },
    },
  });
  add({ type: 19, referenced_message: message(1, `${SCRIPT}${IMG}`, { author: evilUser(3, AVATARS[1] ?? null) }) });
  add({ type: 19, referenced_message: message(1, SCRIPT, { author: 'x' as unknown as User }) });
  add({ type: 19, referenced_message: null });
  add({ edited_timestamp: '"><script>alert(1)</script>' }, 'edited');
  add({ edited_timestamp: at(1000) }, '');
  add({ timestamp: '"><script>alert(1)</script>' }, 'bad time');
  add({ timestamp: 42 as unknown as string }, 'numeric time');
  add({ id: `"><script>alert(1)</script>` as string }, 'bad id');
  add({ id: 12345 as unknown as string }, 'numeric id');
  add({ author: null as unknown as User }, 'no author');
  add({ author: { id: '"><script>', username: IMG, avatar: 'abc' } }, 'odd author id');
  add({ author: { id: '1', username: '', global_name: '   ' } }, 'blank names');
  add({ author: { id: '1', username: '\u202e\u0000', bot: true } }, 'bot with control name');
  add({ type: '<script>' as unknown as number }, 'odd type');
  add({ webhook_id: '"><script>' }, 'hook');
  for (let type = 1; type <= 32; type += 1) add({ type, content: `${SCRIPT}${IMG}`, mentions: [evilUser(1, null)] });
  add({ content: 42 as unknown as string });
  add({ content: null as unknown as string });
  add({ attachments: 'x' as unknown as Attachment[], embeds: {} as unknown as Embed[], reactions: 3 as unknown as never, sticker_items: 'y' as unknown as never });
  return messages;
}

const HOSTILE_OPTIONS = { htmlTheme: `"><script>` as WriterOptions['htmlTheme'], locale: `"><script>` as WriterOptions['locale'], timeZone: `"><script>` };

// ---------------------------------------------------------------------------------------------------------------------

describe('hostile data', () => {
  const messages = hostileMessages();

  it.each([
    ['en', 'dark'],
    ['ko', 'light'],
  ] as const)('cannot become markup, script, handlers or unsafe URLs (%s, %s)', (locale, htmlTheme) => {
    const html = renderExport([messages], context({ target: HOSTILE_TARGET, names: HOSTILE_NAMES, options: { locale, htmlTheme, timeZone: 'Asia/Seoul' } }));
    expect(violations(html)).toEqual([]);
  });

  it('renders every message (nothing is dropped because it looked suspicious)', () => {
    const html = renderExport([messages], context({ target: HOSTILE_TARGET, names: HOSTILE_NAMES }));
    const doc = parseDocument(html);
    expect(doc.querySelectorAll('main > article').length).toBe(messages.length);
  });

  it('shows hostile text as text', () => {
    const html = renderExport([messages], context({ target: HOSTILE_TARGET, names: HOSTILE_NAMES }));
    const doc = parseDocument(html);
    const text = doc.body.textContent ?? '';
    expect(text).toContain(SCRIPT);
    expect(text).toContain(IMG);
    expect(text).toContain('A'.repeat(10_000));
    expect(doc.querySelector('h1.dce-header__title')?.textContent).toBe(`${CLOSERS}${SCRIPT}${BREAKOUT}`);
    // The NUL and the right-to-left override between the two halves become (one) space, as in every single-line field.
    expect(doc.querySelector('.dce-header__topic')?.textContent).toBe(`${CLOSERS}${SCRIPT} ${IMG}`);
    expect(doc.querySelector('.dce-header__channel')?.textContent).toBe(`${CLOSERS}${IMG} / #${CLOSERS}${SCRIPT}${BREAKOUT}${IMG}`);
    expect(doc.querySelectorAll('.md-mention').length).toBeGreaterThan(0);
    expect(Array.from(doc.querySelectorAll('.md-mention')).some((m) => (m.textContent ?? '').includes(SCRIPT))).toBe(true);
  });

  it('cannot break out of the title or the style element', () => {
    const html = renderExport([messages], context({ target: HOSTILE_TARGET, names: HOSTILE_NAMES }));
    const doc = parseDocument(html);
    expect(doc.title).toBe(`${CLOSERS}${SCRIPT}${BREAKOUT} - #${CLOSERS}${SCRIPT}${BREAKOUT}${IMG}`);
    expect(html.slice(html.indexOf('<title>'), html.indexOf('</title>') + 8).match(/</g)!.length).toBe(2);
    expect(doc.querySelector('style')!.textContent).toBe(exportStyles());
    expect(html.indexOf('</style>')).toBe(html.lastIndexOf('</style>'));
  });

  it('does not use hostile option values as markup', () => {
    const html = renderExport([[message(1, 'x')]], context({ options: HOSTILE_OPTIONS }));
    expect(violations(html)).toEqual([]);
    const doc = parseDocument(html);
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('dark');
    expect(Array.from(doc.querySelectorAll('header dd')).map((dd) => dd.textContent)).toContain('2026-10-06 12:34:56 (UTC)');
  });

  it('does not use hostile range bounds as markup', () => {
    const html = renderExport([[message(1, 'x')]], context({ options: { after: `"><script>alert(1)</script>`, before: SCRIPT } }));
    expect(violations(html)).toEqual([]);
  });

  it.each([
    ['direct message', { kind: 'dm', guildId: null, guildName: null, categoryName: null, channelName: `${SCRIPT}${BREAKOUT}` } as const],
    ['group DM', { kind: 'group-dm', guildId: null, guildName: null, categoryName: null, channelName: IMG, iconUrl: 'data:text/html,<script>' } as const],
    ['thread', { kind: 'thread', parentChannelName: `${SCRIPT}${BREAKOUT}`, channelName: IMG } as const],
  ])('keeps a hostile %s target inert', (_name, target) => {
    const html = renderExport([messages.slice(0, 10)], context({ target: { ...HOSTILE_TARGET, ...target } }));
    expect(violations(html)).toEqual([]);
  });

  it('survives hostile data in batches of one message too', () => {
    const html = renderExport(messages.map((m) => [m]), context({ target: HOSTILE_TARGET, names: HOSTILE_NAMES }));
    expect(violations(html)).toEqual([]);
  });

  it('writes the control characters of text as nothing instead of passing them on', () => {
    const html = renderExport([[message(1, 'a\u0000b\u202ec\u0007d')]]);
    expect(html).toContain('<div class="md-root">abcd</div>');
  });
});

describe('text that lands in attribute values', () => {
  const media = (url: string) => ({ url, proxy_url: url, width: 100, height: 100 });
  const render = (extra: Partial<Message>): { html: string; doc: Document } => {
    const html = renderExport([[message(1, '', extra)]]);
    return { html, doc: parseDocument(html) };
  };
  const attributeNames = (element: Element): string[] => element.getAttributeNames().sort();

  it('keeps an embed title inside the alt of the main picture and of the corner thumbnail', () => {
    const { html, doc } = render({
      embeds: [{ type: 'rich', title: ATTRIBUTE_BREAKOUT, image: media('https://media.discordapp.net/a.png'), thumbnail: media('https://media.discordapp.net/t.png') }],
    });
    const pictures = Array.from(doc.querySelectorAll('img.msg-embed__image'));
    expect(pictures).toHaveLength(2);
    for (const picture of pictures) {
      expect(picture.getAttribute('alt')).toBe(ATTRIBUTE_BREAKOUT);
      expect(attributeNames(picture)).toEqual(['alt', 'class', 'decoding', 'height', 'loading', 'src', 'width']);
    }
    expect(html).toContain('alt="x&quot; onerror=&quot;alert(1)&quot; data-x=&quot;"');
    expect(violations(html)).toEqual([]);
  });

  it('does the same when the picture is a link, and when only the provider names the embed', () => {
    const linked = render({ embeds: [{ type: 'image', title: ATTRIBUTE_BREAKOUT, url: 'https://example.com/x', image: media('https://media.discordapp.net/i.png') }] });
    expect(linked.doc.querySelector('a.msg-embed__media-link img')?.getAttribute('alt')).toBe(ATTRIBUTE_BREAKOUT);
    const byProvider = render({ embeds: [{ type: 'rich', provider: { name: ATTRIBUTE_BREAKOUT }, thumbnail: media('https://media.discordapp.net/t.png') }] });
    const picture = byProvider.doc.querySelector('img.msg-embed__image') as Element;
    expect(picture.getAttribute('alt')).toBe(ATTRIBUTE_BREAKOUT);
    expect(attributeNames(picture)).not.toContain('onerror');
    expect(violations(linked.html)).toEqual([]);
    expect(violations(byProvider.html)).toEqual([]);
  });

  it('keeps an embed title inside the aria-label of its video player', () => {
    const { html, doc } = render({ embeds: [{ type: 'video', title: ATTRIBUTE_BREAKOUT, video: media('https://cdn.discordapp.com/v.mp4'), thumbnail: media('https://media.discordapp.net/p.png') }] });
    const player = doc.querySelector('video.msg-video') as Element;
    expect(player.getAttribute('aria-label')).toBe(ATTRIBUTE_BREAKOUT);
    expect(player.hasAttribute('onerror')).toBe(false);
    expect(player.hasAttribute('data-x')).toBe(false);
    expect(violations(html)).toEqual([]);
  });

  it('keeps attachment descriptions and names, sticker names and reaction names inside their attributes', () => {
    const { html, doc } = render({
      attachments: [
        { id: '1', filename: 'a.png', size: 1, content_type: 'image/png', url: 'https://cdn.discordapp.com/a.png', description: ATTRIBUTE_BREAKOUT },
        { id: '2', filename: `${ATTRIBUTE_BREAKOUT}.mp4`, size: 1, content_type: 'video/mp4', url: 'https://cdn.discordapp.com/v.mp4' },
        { id: '3', filename: `${ATTRIBUTE_BREAKOUT}.mp3`, size: 1, content_type: 'audio/mpeg', url: 'https://cdn.discordapp.com/s.mp3' },
      ],
      sticker_items: [{ id: '123456789012345678', name: ATTRIBUTE_BREAKOUT, format_type: 1 }],
      reactions: [{ count: 1, emoji: { id: '123456789012345679', name: ATTRIBUTE_BREAKOUT } }],
    });
    expect(doc.querySelector('img.msg-image')?.getAttribute('alt')).toBe(ATTRIBUTE_BREAKOUT);
    expect(doc.querySelector('video.msg-video')?.getAttribute('aria-label')).toBe(`${ATTRIBUTE_BREAKOUT}.mp4`);
    expect(doc.querySelector('audio.msg-audio')?.getAttribute('aria-label')).toBe(`${ATTRIBUTE_BREAKOUT}.mp3`);
    const sticker = doc.querySelector('img.msg-sticker__image') as Element;
    expect(sticker.getAttribute('alt')).toBe(ATTRIBUTE_BREAKOUT);
    expect(sticker.getAttribute('title')).toBe(ATTRIBUTE_BREAKOUT);
    const reaction = doc.querySelector('.msg-reaction') as Element;
    expect(reaction.getAttribute('title')).toBe(`:${ATTRIBUTE_BREAKOUT}:`);
    expect(violations(html)).toEqual([]);
  });

  it('keeps an author name and a message id inside their attributes', () => {
    const { html, doc } = render({ author: { id: '1', username: ATTRIBUTE_BREAKOUT }, id: ATTRIBUTE_BREAKOUT });
    const article = doc.querySelector('main > article') as Element;
    expect(article.getAttribute('data-message-id')).toBe(ATTRIBUTE_BREAKOUT);
    expect(article.getAttribute('aria-label')?.startsWith(ATTRIBUTE_BREAKOUT)).toBe(true);
    expect(article.hasAttribute('onerror')).toBe(false);
    expect(violations(html)).toEqual([]);
  });
});

describe('random hostile text', () => {
  const TOKENS = [
    '**', '__', '~~', '||', '`', '```', '> ', '>>> ', '# ', '## ', '-# ', '- ', '1. ', '[', '](', ')', '<', '>', '</', '"', "'", '&', '&amp;', '&#60;', '\n', '\r\n', '\t', '\u0000', '\u202e',
    '<@1>', '<#1>', '<@&1>', '<:a:1>', '<a:b:123456789012345678>', '<t:1:R>', '@everyone', 'https://example.com/', 'https://example.com/a(b)c', 'javascript:alert(1)', 'data:text/html,x',
    'mailto:a@b.c', 'onerror=', 'onclick="alert(1)"', '<script>', '</script>', '<img src=x>', '</style>', '</title>', '<!--', '-->', ' ', 'a', 'é', '한', '😀', '\\', '*', '_',
  ];

  /** Deterministic PRNG, so that a failure can be reproduced. */
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hostileChannel(seed: number): string {
    const random = mulberry32(seed);
    const text = (maxTokens: number): string => {
      let out = '';
      for (let i = Math.floor(random() * maxTokens) + 1; i > 0; i -= 1) out += TOKENS[Math.floor(random() * TOKENS.length)]!;
      return out;
    };
    const messages: Message[] = [];
    for (let n = 1; n <= 250; n += 1) {
      messages.push(
        message(n, text(14), {
          author: { id: String(1000 + (n % 5)), username: text(4), global_name: random() < 0.5 ? text(4) : null, avatar: random() < 0.3 ? text(3) : null },
          timestamp: at(n * 40 * SECOND),
          embeds:
            random() < 0.4
              ? [{ title: text(5), description: text(10), url: text(2), fields: [{ name: text(3), value: text(6), inline: random() < 0.5 }], footer: { text: text(3) }, author: { name: text(3), url: text(2) } }]
              : [],
          attachments:
            random() < 0.3
              ? [{ id: '1', filename: text(4), size: 5, url: `https://cdn.discordapp.com/${text(3)}`, content_type: random() < 0.5 ? 'image/png' : 'video/mp4' }]
              : [],
          reactions: random() < 0.2 ? [{ count: 1, emoji: { id: random() < 0.5 ? text(1) : null, name: text(2) } }] : [],
          ...(random() < 0.15 ? { type: Math.floor(random() * 32), content: text(6) } : {}),
        }),
      );
    }
    const names: NameResolver = { user: () => text(3), channel: () => text(3), role: () => text(3) };
    return renderExport([messages], context({ target: { ...HOSTILE_TARGET, topic: text(8), guildName: text(5) }, names }));
  }

  it.each([20261006, 1, 2, 3, 4])('never produces unsafe output, whatever the combination of syntax and markup characters (seed %i)', (seed) => {
    expect(violations(hostileChannel(seed))).toEqual([]);
  });
});

describe('the safe cases still work next to the hostile ones', () => {
  it('keeps real links, mentions and Discord pictures intact', () => {
    const html = renderExport([[message(1, '[docs](https://example.com/a) <@2000>', { attachments: [{ id: '1', filename: 'a.png', size: 1, content_type: 'image/png', url: 'https://cdn.discordapp.com/a.png' } as Attachment] })]]);
    const doc = parseDocument(html);
    expect(doc.querySelector('a.md-link')?.getAttribute('href')).toBe('https://example.com/a');
    expect(doc.querySelector('img.msg-image')?.getAttribute('src')).toBe('https://cdn.discordapp.com/a.png');
    expect(violations(html)).toEqual([]);
  });
});

describe('saved attachment copies cannot inject anything either', () => {
  const files: Attachment[] = [
    { id: '1', filename: 'a.png', size: 1, content_type: 'image/png', url: 'https://cdn.discordapp.com/a.png' } as Attachment,
    { id: '2', filename: 'v.mp4', size: 1, content_type: 'video/mp4', url: 'https://cdn.discordapp.com/v.mp4' } as Attachment,
    { id: '3', filename: 's.mp3', size: 1, content_type: 'audio/mpeg', url: 'https://cdn.discordapp.com/s.mp3' } as Attachment,
    { id: '4', filename: 'r.pdf', size: 1, content_type: 'application/pdf', url: 'https://cdn.discordapp.com/r.pdf' } as Attachment,
    { id: '5', filename: 'SPOILER_x.png', size: 1, content_type: 'image/png', url: 'https://cdn.discordapp.com/x.png' } as Attachment,
  ];
  const render = (path: string): string =>
    renderExport([[message(1, 'x', { attachments: files })]], context({ options: { attachmentPaths: new Map(files.map((file) => [file.id, path])) } }));

  const RLO = String.fromCharCode(0x202e);
  const LONE_SURROGATE = String.fromCharCode(0xd800);
  const NUL = String.fromCharCode(0);
  const LF = String.fromCharCode(10);
  const BACKSLASH = String.fromCharCode(92);

  // Paths the writer accepts: whatever they contain, every character that is not a letter, digit or mark ends up percent-encoded.
  it.each([
    `x" onerror="alert(1)" data-x="`,
    `${SCRIPT}/a.png`,
    `${CLOSERS}/a.png`,
    `a/${BREAKOUT}/b.png`,
    'a b/c d.png',
    '%2e%2e/%2e%2e/x.png',
    `a/${RLO}/b.png`,
    `a/${LONE_SURROGATE}/b.png`,
    `files/${'a\u030a'.repeat(3)}/b.png`,
    `${'a'.repeat(900)}/b.png`,
  ])('accepts %j as inert text', (path) => {
    const html = render(path);
    expect(violations(html, true)).toEqual([]);
    const doc = parseDocument(html);
    // every attachment shows its copy
    expect(doc.querySelectorAll('img.msg-image').length).toBe(2);
    expect(doc.querySelector('video.msg-video')?.getAttribute('src')).not.toMatch(/^https:/);
    expect(doc.querySelector('audio.msg-audio')?.getAttribute('src')).not.toMatch(/^https:/);
    expect(html).not.toContain('alert(1)" data-x');
  });

  // Paths the writer refuses: the attachment is shown as if no copy existed (CDN picture, CDN link).
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'C:/Windows/system.ini',
    `C:${BACKSLASH}Windows${BACKSLASH}system.ini`,
    '//evil.example/x.png',
    '/evil.png',
    '../up.png',
    'a/../../up.png',
    'a/./b.png',
    'a//b.png',
    'a/b/',
    `a${BACKSLASH}b.png`,
    `a${NUL}b.png`,
    `a${LF}b.png`,
    'a'.repeat(1025),
    '',
  ])('refuses %j and falls back to the Discord links', (path) => {
    const html = render(path);
    expect(violations(html, true)).toEqual([]);
    const doc = parseDocument(html);
    expect(doc.querySelector('img.msg-image')?.getAttribute('src')).toBe('https://cdn.discordapp.com/a.png');
    expect(doc.querySelector('video.msg-video')?.getAttribute('src')).toBe('https://cdn.discordapp.com/v.mp4');
    expect(html).not.toMatch(/(?:src|href)="(?:javascript|data:text|file):/i);
  });

  it('keeps the file card of a saved document inside its attributes', () => {
    const html = renderExport([[message(1, 'x', { attachments: [files[3]!] })]], context({ options: { attachmentPaths: new Map([['4', `${ATTRIBUTE_BREAKOUT}/r.pdf`]]) } }));
    expect(violations(html, true)).toEqual([]);
    const link = parseDocument(html).querySelector('a.msg-file__name') as Element;
    expect(link.getAttribute('href')).toBe('x%22%20onerror%3D%22alert%281%29%22%20data-x%3D%22/r.pdf');
    expect(link.getAttributeNames().sort()).toEqual(['class', 'dir', 'href', 'rel', 'target']);
  });

  it('is still strict for a file without saved copies', () => {
    const html = renderExport([[message(1, 'x', { attachments: files })]], context({ options: { attachmentPaths: new Map() } }));
    expect(violations(html)).toEqual([]);
  });

  it('hostile text next to saved copies stays inert', () => {
    const embed: Embed = { type: 'rich', title: ATTRIBUTE_BREAKOUT, image: { url: 'https://example.com/i.png', proxy_url: 'https://media.discordapp.net/i.png', width: 10, height: 10 } };
    const hostile = message(1, `${SCRIPT} ${IMG} [x](javascript:alert(1))`, { attachments: files, embeds: [embed] });
    const copies = new Map(files.map((file) => [file.id, `Chat_files/${file.id}_${file.filename}`]));
    const html = renderExport([[hostile]], context({ target: HOSTILE_TARGET, names: HOSTILE_NAMES, options: { attachmentPaths: copies } }));
    expect(violations(html, true)).toEqual([]);
  });
});
