// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@/lib/markdown/parse';
import { escapeHtml, renderHtml } from '@/lib/markdown/renderHtml';
import type { MarkdownContext, MdNode } from '@/lib/markdown/types';
import { fastestRunMs } from './timing';

const USERS: Record<string, string> = { '1': 'Alice', '666': '<img src=x onerror=alert(1)>' };
const CHANNELS: Record<string, string> = { '5': 'general', '666': '"><script>alert(1)</script>' };
const ROLES: Record<string, string> = { '9': 'Mods', '666': "'onmouseover='alert(1)" };

const ctx: MarkdownContext = {
  names: { user: (id) => USERS[id], channel: (id) => CHANNELS[id], role: (id) => ROLES[id] },
  locale: 'en',
  timeZone: 'UTC',
};

const html = (md: string, opts?: { jumbo?: boolean }) => renderHtml(parseMarkdown(md), ctx, opts);

function fragment(markup: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = markup;
  return template.content;
}

// ---- structural safety check used by the whole XSS corpus ---------------------------------------------------------------
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  strong: [],
  em: [],
  u: [],
  s: [],
  br: [],
  li: [],
  code: ['class'],
  blockquote: ['class'],
  ul: ['class'],
  ol: ['class', 'start'],
  pre: ['class', 'data-lang'],
  div: ['class', 'role', 'aria-level'],
  span: ['class', 'tabindex'],
  time: ['class', 'datetime', 'title'],
  a: ['class', 'href', 'target', 'rel', 'title'],
  img: ['class', 'alt', 'title', 'src', 'loading', 'decoding', 'draggable'],
};

function assertSafe(markup: string): void {
  const root = fragment(markup);
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    const allowed = ALLOWED_ATTRIBUTES[tag];
    expect(allowed, `element <${tag}> must not be emitted (${markup})`).toBeDefined();
    for (const attr of Array.from(el.attributes)) {
      expect(allowed, `<${tag} ${attr.name}> must not be emitted (${markup})`).toContain(attr.name);
      expect(attr.name.startsWith('on')).toBe(false);
    }
    if (tag === 'a') {
      expect(el.getAttribute('href') ?? '').toMatch(/^(https?:|mailto:)/);
      expect(el.getAttribute('target')).toBe('_blank');
      expect(el.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    }
    if (tag === 'img') {
      expect(el.getAttribute('src') ?? '').toMatch(/^https:\/\/cdn\.discordapp\.com\//);
      expect(el.getAttribute('loading')).toBe('lazy');
    }
  }
  // After removing every tag we are allowed to emit, no angle bracket may be left: text is always escaped.
  const stripped = markup.replace(/<\/?(strong|em|u|s|span|code|pre|blockquote|div|ul|ol|li|a|img|time|br)(\s[^<>]*)?>/g, '');
  expect(stripped).not.toMatch(/[<>]/);
}

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &#39; f');
  });
  it('leaves everything else alone', () => {
    expect(escapeHtml('안녕 😀 plain')).toBe('안녕 😀 plain');
    expect(escapeHtml('')).toBe('');
  });
  it('escapes ampersands first so entities typed by users stay visible', () => {
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });
});

describe('renderHtml: output per node type', () => {
  it.each([
    ['text is escaped', `a & b < c > "d" 'e'`, 'a &amp; b &lt; c &gt; &quot;d&quot; &#39;e&#39;'],
    ['newline', 'a\nb', 'a<br>b'],
    ['bold', '**b**', '<strong>b</strong>'],
    ['italic', '*i* _j_', '<em>i</em> <em>j</em>'],
    ['underline', '__u__', '<u>u</u>'],
    ['strike', '~~s~~', '<s>s</s>'],
    ['spoiler', '||x||', '<span class="md-spoiler" tabindex="0">x</span>'],
    ['nested formatting', '**a *b* c**', '<strong>a <em>b</em> c</strong>'],
    ['inline code', '`a<b`', '<code class="md-code">a&lt;b</code>'],
    ['code block with language', '```js\nx < 1\n```', '<pre class="md-pre" data-lang="js"><code>x &lt; 1</code></pre>'],
    ['code block without language', '```\nx\n```', '<pre class="md-pre"><code>x</code></pre>'],
    ['quote', '> a\n> b', '<blockquote class="md-quote">a<br>b</blockquote>'],
    ['heading', '## H', '<div class="md-heading md-h2" role="heading" aria-level="2">H</div>'],
    ['subtext', '-# s', '<div class="md-subtext">s</div>'],
    ['bullet list', '- a\n- b', '<ul class="md-list"><li>a</li><li>b</li></ul>'],
    ['ordered list', '1. a\n2. b', '<ol class="md-list"><li>a</li><li>b</li></ol>'],
    ['ordered list with a start number', '3. a\n4. b', '<ol class="md-list" start="3"><li>a</li><li>b</li></ol>'],
    ['nested list', '- a\n  - b', '<ul class="md-list"><li>a<ul class="md-list"><li>b</li></ul></li></ul>'],
    [
      'bare link',
      'https://a.com/x',
      '<a class="md-link" href="https://a.com/x" target="_blank" rel="noopener noreferrer nofollow">https://a.com/x</a>',
    ],
    [
      'masked link shows the real url in the title',
      '[docs](https://a.com/d)',
      '<a class="md-link" href="https://a.com/d" target="_blank" rel="noopener noreferrer nofollow" title="https://a.com/d">docs</a>',
    ],
    ['user mention', '<@1>', '<span class="md-mention">@Alice</span>'],
    ['unknown user mention', '<@2>', '<span class="md-mention">@Unknown User</span>'],
    ['role mention', '<@&9>', '<span class="md-mention">@Mods</span>'],
    ['channel mention', '<#5>', '<span class="md-mention">#general</span>'],
    ['everyone', '@everyone', '<span class="md-mention">@everyone</span>'],
    [
      'custom emoji',
      '<:smile:111>',
      '<img class="md-emoji" alt=":smile:" title=":smile:" src="https://cdn.discordapp.com/emojis/111.png?size=44" loading="lazy" decoding="async" draggable="false">',
    ],
    [
      'animated emoji',
      '<a:dance:222>',
      '<img class="md-emoji" alt=":dance:" title=":dance:" src="https://cdn.discordapp.com/emojis/222.webp?size=44&amp;animated=true" loading="lazy" decoding="async" draggable="false">',
    ],
    [
      'timestamp',
      '<t:1543392060>',
      '<time class="md-time" datetime="2018-11-28T08:01:00.000Z" title="Wednesday, November 28, 2018 8:01 AM">November 28, 2018 8:01 AM</time>',
    ],
    [
      'relative timestamp is static',
      '<t:1543392060:R>',
      '<time class="md-time" datetime="2018-11-28T08:01:00.000Z" title="Wednesday, November 28, 2018 8:01 AM">November 28, 2018 8:01 AM</time>',
    ],
    ['korean text', '**안녕** 세계', '<strong>안녕</strong> 세계'],
  ])('%s', (_name, input, expected) => {
    expect(html(input)).toBe(expected);
  });

  it('allows mailto links on hand-built nodes', () => {
    const nodes: MdNode[] = [{ type: 'link', url: 'mailto:a@b.co', children: [{ type: 'text', text: 'mail' }], masked: false }];
    expect(renderHtml(nodes, ctx)).toBe(
      '<a class="md-link" href="mailto:a@b.co" target="_blank" rel="noopener noreferrer nofollow">mail</a>',
    );
  });

  it('renders an empty list of nodes as an empty string', () => {
    expect(renderHtml([], ctx)).toBe('');
  });

  it('localises the placeholders of unresolvable mentions', () => {
    const nodes = parseMarkdown('<@2> <#2> <@&2>');
    expect(renderHtml(nodes, { ...ctx, locale: 'ko' })).toBe(
      '<span class="md-mention">@알 수 없는 사용자</span> <span class="md-mention">#알 수 없는 채널</span> <span class="md-mention">@삭제된-역할</span>',
    );
  });
});

describe('renderHtml: jumbo emoji', () => {
  it('marks custom emoji as jumbo', () => {
    expect(html('<:a:1>', { jumbo: true })).toContain('class="md-emoji md-emoji-jumbo"');
    expect(html('<:a:1>')).not.toContain('md-emoji-jumbo');
  });

  it('wraps unicode emoji in jumbo spans', () => {
    expect(html('😀 😎', { jumbo: true })).toBe('<span class="md-emoji-jumbo">😀</span> <span class="md-emoji-jumbo">😎</span>');
    expect(html('😀 😎')).toBe('😀 😎');
  });
});

describe('renderHtml: XSS corpus', () => {
  it('the safety checker itself rejects unsafe markup', () => {
    for (const bad of [
      '<script>alert(1)</script>',
      '<img src="https://cdn.discordapp.com/x.png" onerror="alert(1)" loading="lazy">',
      '<a class="md-link" href="javascript:alert(1)" target="_blank" rel="noopener noreferrer nofollow">x</a>',
      '<a class="md-link" href="https://a.com" target="_blank">x</a>',
      '<img src="https://evil.example/x.png" loading="lazy">',
      '<span style="x:y">x</span>',
      'text with < raw bracket',
    ]) {
      expect(() => assertSafe(bad), bad).toThrow();
    }
  });

  const corpus = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
    '<scr<script>ipt>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<img src="x" onerror="alert(1)">',
    '<svg/onload=alert(1)>',
    '<svg><script>alert(1)</script></svg>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<style>*{display:none}</style>',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<base href="https://evil.example/">',
    '<form action="https://evil.example"><input name=x></form>',
    '<!-- comment --> <![CDATA[x]]>',
    '<math><mtext><script>alert(1)</script></mtext></math>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](java\nscript:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x]( javascript:alert(1))',
    '[x](<javascript:alert(1)>)',
    '[x](&#106;avascript:alert(1))',
    '[x](javascript&colon;alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[x](vbscript:msgbox(1))',
    '[x](file:///etc/passwd)',
    '[x](blob:https://a.com/uuid)',
    '[x](//evil.example)',
    '[x](https://a.com" onmouseover="alert(1))',
    '[x](https://a.com/"><script>alert(1)</script>)',
    "[x](https://a.com/' onmouseover='alert(1))",
    '[x](<https://a.com/" onmouseover="alert(1)>)',
    '<https://a.com/"onmouseover="alert(1)>',
    '<javascript:alert(1)>',
    'https://a.com/"onmouseover="alert(1)',
    "https://a.com/'onmouseover='alert(1)",
    'https://a.com/<script>alert(1)</script>',
    'javascript:alert(1)',
    '[<img src=x onerror=alert(1)>](https://a.com)',
    '[a](https://a.com){onclick=alert(1)}',
    '**<script>alert(1)</script>**',
    '`<script>alert(1)</script>`',
    '```html\n<script>alert(1)</script>\n```',
    '```"><script>alert(1)</script>\n x\n```',
    '```"onload="alert(1)\nx\n```',
    '> <script>alert(1)</script>',
    '# <img src=x onerror=alert(1)>',
    '-# <img src=x onerror=alert(1)>',
    '- <img src=x onerror=alert(1)>',
    '1. <script>alert(1)</script>',
    '||<script>alert(1)</script>||',
    '<@666> <#666> <@&666>',
    '<@1><script>alert(1)</script>',
    '<:x"onerror="alert(1):123>',
    '<:x:1"onerror="alert(1)>',
    '<:x:1><script>',
    '<t:1700000000:"onerror=">',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '&#60;script&#62;alert(1)&#60;/script&#62;',
    '\\<script>alert(1)\\</script>',
    '\0<script>alert(1)</script>',
    '<script>alert(1)</script>'.repeat(50),
    '"><script>alert(1)</script>',
    "'><script>alert(1)</script>",
    '</span><script>alert(1)</script>',
    '</pre><script>alert(1)</script>',
    '</code></pre><script>alert(1)</script>',
  ];

  it.each(corpus.map((c) => [JSON.stringify(c).slice(0, 70), c]))('%s', (_label, input) => {
    assertSafe(html(input as string));
  });

  it('shows markup as text instead of interpreting it', () => {
    expect(html('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(fragment(html('<b>hi</b>')).querySelector('b')).toBeNull();
  });

  it('keeps entity-looking text as text', () => {
    expect(html('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
    expect(fragment(html('&#60;script&#62;')).textContent).toBe('&#60;script&#62;');
  });

  it('never turns a dangerous scheme into a link', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd']) {
      const out = html(`[click](${bad})`);
      expect(out).not.toContain('<a ');
      expect(fragment(out).textContent).toBe(`[click](${bad})`);
    }
  });

  it('percent-encodes quotes inside a link target so they cannot break the attribute', () => {
    const out = html('[x](https://a.com/"onmouseover="alert(1))');
    const a = fragment(out).querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('onmouseover')).toBeNull();
    expect(a!.getAttribute('href')).not.toContain('"');
    assertSafe(out);
  });

  it('escapes names coming from the resolver', () => {
    const out = html('<@666> <#666> <@&666>');
    expect(out).toContain('@&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('#&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('@&#39;onmouseover=&#39;alert(1)');
    assertSafe(out);
  });

  describe('hand-built nodes that bypass the parser', () => {
    it('rejects dangerous link targets', () => {
      for (const url of ['javascript:alert(1)', 'data:text/html,x', ' javascript:alert(1)', 'java\nscript:alert(1)', '']) {
        const nodes: MdNode[] = [{ type: 'link', url, children: [{ type: 'text', text: 'x' }], masked: true }];
        const out = renderHtml(nodes, ctx);
        expect(out).toBe('x');
      }
    });

    it('escapes hostile emoji fields and keeps the image on the Discord CDN', () => {
      const nodes: MdNode[] = [{ type: 'emoji', name: 'x"><script>alert(1)</script>', id: '1" onerror="alert(1)', animated: false }];
      assertSafe(renderHtml(nodes, ctx));
      const nodes2: MdNode[] = [{ type: 'emoji', name: 'ok', id: '../../evil', animated: true }];
      assertSafe(renderHtml(nodes2, ctx));
    });

    it('escapes a hostile code language', () => {
      const nodes: MdNode[] = [{ type: 'codeBlock', lang: 'x" onload="alert(1)', text: '</code></pre><script>alert(1)</script>' }];
      const out = renderHtml(nodes, ctx);
      expect(fragment(out).querySelector('script')).toBeNull();
      expect(fragment(out).querySelector('pre')!.getAttribute('onload')).toBeNull();
      assertSafe(out);
    });

    it('does not emit a time element for impossible dates', () => {
      const nodes: MdNode[] = [{ type: 'timestamp', unix: 1e20, style: 'f' }];
      expect(renderHtml(nodes, ctx)).toBe('100000000000000000000');
    });

    it('survives a non-numeric list start', () => {
      const nodes: MdNode[] = [{ type: 'list', ordered: true, start: Number.NaN, items: [[{ type: 'text', text: 'a' }]] }];
      expect(renderHtml(nodes, ctx)).toBe('<ol class="md-list"><li>a</li></ol>');
    });
  });

  describe('huge and adversarial input', () => {
    it('escapes two million angle brackets', () => {
      const out = html('<'.repeat(2_000_000));
      expect(out.length).toBe(4 * 2_000_000);
      expect(out.startsWith('&lt;&lt;')).toBe(true);
      expect(out).not.toContain('<');
    });

    it('renders a 1.5 MB message mixing every construct, safely and quickly', () => {
      const unit = '**a** <@1> [x](https://a.com) `c<` ||s|| <script> <:e:1> <t:1543392060> # h\n- i\n> q\n';
      const input = unit.repeat(20_000);
      let out = '';
      // Rendering itself takes ~0.4 s; the ceiling is generous because the suite runs files in parallel.
      expect(fastestRunMs(5_000, () => void (out = html(input)), 3)).toBeLessThan(5_000);
      expect(out.length).toBeGreaterThan(input.length);
      // Parsing the 12 MB result with jsdom is the slow part of this test, so it gets a longer per-test timeout.
      const root = fragment(out);
      expect(root.querySelector('script')).toBeNull();
      expect(root.querySelectorAll('strong')).toHaveLength(20_000);
    }, 60_000);

    it('does not interpret deeply nested markers beyond the cap', () => {
      const out = html('*_'.repeat(10_000) + '<script>' + '_*'.repeat(10_000));
      assertSafe(out);
    });
  });
});
