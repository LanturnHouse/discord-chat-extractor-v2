import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, emojiOnlyCount, isEmojiOnly, parseMarkdown, splitUnicodeEmoji } from '@/lib/markdown/parse';
import type { MdNode } from '@/lib/markdown/types';

// ---- tiny AST builders so that the tables below read like the markdown they describe ----------------------------------
const t = (text: string): MdNode => ({ type: 'text', text });
const br: MdNode = { type: 'br' };
const strong = (...children: MdNode[]): MdNode => ({ type: 'strong', children });
const em = (...children: MdNode[]): MdNode => ({ type: 'em', children });
const underline = (...children: MdNode[]): MdNode => ({ type: 'underline', children });
const strike = (...children: MdNode[]): MdNode => ({ type: 'strike', children });
const spoiler = (...children: MdNode[]): MdNode => ({ type: 'spoiler', children });
const code = (text: string): MdNode => ({ type: 'inlineCode', text });
const fence = (text: string, lang: string | null = null): MdNode => ({ type: 'codeBlock', lang, text });
const quote = (...children: MdNode[]): MdNode => ({ type: 'blockQuote', children });
const heading = (level: 1 | 2 | 3, ...children: MdNode[]): MdNode => ({ type: 'heading', level, children });
const subtext = (...children: MdNode[]): MdNode => ({ type: 'subtext', children });
const ul = (...items: MdNode[][]): MdNode => ({ type: 'list', ordered: false, start: 1, items });
const ol = (start: number, ...items: MdNode[][]): MdNode => ({ type: 'list', ordered: true, start, items });
const bare = (url: string): MdNode => ({ type: 'link', url, children: [t(url)], masked: false });
const masked = (url: string, ...children: MdNode[]): MdNode => ({ type: 'link', url, children, masked: true });
const emoji = (name: string, id: string, animated = false): MdNode => ({ type: 'emoji', name, id, animated });
const user = (id: string): MdNode => ({ type: 'mentionUser', id });

type Case = [name: string, input: string, expected: MdNode[]];
const run = (cases: Case[]) => {
  it.each(cases)('%s', (_name, input, expected) => {
    expect(parseMarkdown(input)).toEqual(expected);
  });
};

function maxDepth(nodes: MdNode[]): number {
  let max = 0;
  for (const node of nodes) {
    let d = 0;
    if ('children' in node) d = 1 + maxDepth(node.children);
    else if (node.type === 'list') d = 1 + Math.max(0, ...node.items.map(maxDepth));
    max = Math.max(max, d);
  }
  return max;
}

describe('parseMarkdown: plain text and newlines', () => {
  run([
    ['empty', '', []],
    ['plain', 'hello world', [t('hello world')]],
    ['newline becomes br', 'a\nb', [t('a'), br, t('b')]],
    ['blank line is a second br', 'a\n\nb', [t('a'), br, br, t('b')]],
    ['CRLF is normalised', 'a\r\nb\rc', [t('a'), br, t('b'), br, t('c')]],
    ['trailing newline is dropped', 'a\n', [t('a')]],
    ['unicode text is untouched', '안녕하세요 😀 \u00e9', [t('안녕하세요 😀 \u00e9')]],
  ]);
});

describe('parseMarkdown: inline formatting', () => {
  run([
    ['bold', '**bold**', [strong(t('bold'))]],
    ['italic with *', '*it*', [em(t('it'))]],
    ['italic with _', '_it_', [em(t('it'))]],
    ['underline', '__u__', [underline(t('u'))]],
    ['strike', '~~s~~', [strike(t('s'))]],
    ['spoiler', '||secret||', [spoiler(t('secret'))]],
    ['bold italic', '***bi***', [em(strong(t('bi')))]],
    ['underline italic', '__*ui*__', [underline(em(t('ui')))]],
    ['underline bold', '__**ub**__', [underline(strong(t('ub')))]],
    ['underline italic with ___', '___ui___', [em(underline(t('ui')))]],
    ['text around', 'a **b** c', [t('a '), strong(t('b')), t(' c')]],
    ['nested', 'a **b *c* d** e', [t('a '), strong(t('b '), em(t('c')), t(' d')), t(' e')]],
    ['spoiler containing formatting', '||a **b** c||', [spoiler(t('a '), strong(t('b')), t(' c'))]],
    ['strike inside bold', '**~~x~~**', [strong(strike(t('x')))]],
    ['bold across a line break', '**a\nb**', [strong(t('a'), br, t('b'))]],
    ['spoiler across a line break', '||a\nb||', [spoiler(t('a'), br, t('b'))]],
    ['intraword asterisks', '2*3*4', [t('2'), em(t('3')), t('4')]],
    ['two separate bolds', '**a** and **b**', [strong(t('a')), t(' and '), strong(t('b'))]],
    ['adjacent bolds', '**a**b**c**', [strong(t('a')), t('b'), strong(t('c'))]],
    ['"* " at the start of a line is a list marker, not italic', '* a *', [ul([t('a *')])]],
    ['asterisks surrounded by spaces are literal', 'a * b * c', [t('a * b * c')]],
    ['double underscore underlines inside a word like Discord', '__init__.py', [underline(t('init')), t('.py')]],
    ['spoiler pairs are consumed from the start of a run', '|||a|||', [spoiler(t('|a')), t('|')]],
    ['extra tildes stay in the content', '~~~a~~', [strike(t('~a'))]],
  ]);
});

describe('parseMarkdown: snake_case and word boundaries for underscores', () => {
  run([
    ['snake_case_name is not italic', 'snake_case_name', [t('snake_case_name')]],
    ['trailing underscore after a word', 'foo_bar_ baz', [t('foo_bar_ baz')]],
    ['single underscore in a word', 'a_b', [t('a_b')]],
    ['italic can contain an inner underscore', '_a_b_', [em(t('a_b'))]],
    ['snake_case next to real italics', 'my_var and _real_', [t('my_var and '), em(t('real'))]],
    ['italic at word edges with punctuation', '(_x_)', [t('('), em(t('x')), t(')')]],
    ['digits are word characters', '1_2_3', [t('1_2_3')]],
  ]);
});

describe('parseMarkdown: unclosed and degenerate markers stay literal', () => {
  run([
    ['unclosed bold', '**a', [t('**a')]],
    ['unclosed italic', '*a', [t('*a')]],
    ['unclosed underscore', '_a', [t('_a')]],
    ['unclosed underline', '__a', [t('__a')]],
    ['unclosed strike', '~~a', [t('~~a')]],
    ['unclosed spoiler', '||a', [t('||a')]],
    ['unclosed code', '`a', [t('`a')]],
    ['bold marker with nothing inside', '****', [t('****')]],
    ['bold marker with only a space', '** **', [t('** **')]],
    ['empty spoiler', '||||', [t('||||')]],
    ['single tilde and pipe', 'a ~ b | c', [t('a ~ b | c')]],
    ['unclosed inner marker stays literal inside a closed outer one', '**a _b**', [strong(t('a _b'))]],
    ['mismatched lengths pair like CommonMark', '**a *b**', [t('*'), em(t('a '), em(t('b')))]],
    ['unclosed outer marker, closed inner one', '**a *b* c', [t('**a '), em(t('b')), t(' c')]],
    ['unclosed link text', '[a', [t('[a')]],
    ['link text without destination', '[a]', [t('[a]')]],
    ['unclosed destination', '[a](https://a.com', [t('[a]('), bare('https://a.com')]],
    ['lone closing bracket', 'a]', [t('a]')]],
    ['unclosed mention', '<@123', [t('<@123')]],
    ['malformed mention', '<@abc>', [t('<@abc>')]],
    ['malformed emoji', '<:smile:abc>', [t('<:smile:abc>')]],
    ['malformed timestamp', '<t:abc>', [t('<t:abc>')]],
    ['unknown timestamp style', '<t:1:x>', [t('<t:1:x>')]],
    ['timestamp outside the Date range', '<t:99999999999999>', [t('<t:99999999999999>')]],
  ]);
});

describe('parseMarkdown: backslash escapes', () => {
  run([
    ['escaped asterisks', '\\*not\\*', [t('*not*')]],
    ['escaped underscores', '\\_x\\_', [t('_x_')]],
    ['escaped backslash', '\\\\', [t('\\')]],
    ['backslash before a letter stays', '\\a', [t('\\a')]],
    ['backslash before a space stays', '\\ a', [t('\\ a')]],
    ['trailing backslash stays', 'a\\', [t('a\\')]],
    ['escaped backtick', '\\`not code`', [t('`not code`')]],
    ['escaped mention', '\\<@123>', [t('<@123>')]],
    ['escaped spoiler marker', '\\||a||', [t('||a||')]],
    ['escape then real emphasis', '\\**bold**', [t('*'), em(t('bold')), t('*')]],
    ['escaped bracket prevents a link', '\\[a](https://a.com)', [t('[a]('), bare('https://a.com'), t(')')]],
    ['escaped non-ascii character', '\\한', [t('한')]],
  ]);
});

describe('parseMarkdown: inline code', () => {
  run([
    ['simple', '`code`', [code('code')]],
    ['markdown inside is verbatim', '`a **b** _c_ <@1>`', [code('a **b** _c_ <@1>')]],
    ['double backticks may contain a backtick', '``a ` b``', [code('a ` b')]],
    ['one padding space is stripped', '`` `x` ``', [code('`x`')]],
    ['all-space body keeps its spaces', '` `', [code(' ')]],
    ['runs of different length do not pair', '`a``', [t('`a``')]],
    ['single backticks can wrap a double-backtick run', '`a ``b` c', [code('a ``b'), t(' c')]],
    ['code spans can contain newlines', '`a\nb`', [code('a\nb')]],
    ['text around', 'x `y` z', [t('x '), code('y'), t(' z')]],
    ['two spans', '`a` `b`', [code('a'), t(' '), code('b')]],
    ['emphasis markers inside do not leak', '**a `**` b**', [strong(t('a '), code('**'), t(' b'))]],
  ]);
});

describe('parseMarkdown: links', () => {
  run([
    ['bare https', 'https://example.com', [bare('https://example.com')]],
    ['bare http with path and query', 'see http://a.com/x?y=1&z=2 now', [t('see '), bare('http://a.com/x?y=1&z=2'), t(' now')]],
    ['trailing period', 'go to https://a.com.', [t('go to '), bare('https://a.com'), t('.')]],
    ['trailing comma', 'https://a.com, ok', [bare('https://a.com'), t(', ok')]],
    ['trailing colon, semicolon, bang, question', 'https://a.com/x:;!?', [bare('https://a.com/x'), t(':;!?')]],
    ['unbalanced closing parenthesis', '(see https://a.com/x)', [t('(see '), bare('https://a.com/x'), t(')')]],
    ['balanced parentheses stay in the url', 'https://en.wikipedia.org/wiki/Foo_(bar)', [bare('https://en.wikipedia.org/wiki/Foo_(bar)')]],
    ['balanced parentheses then a period', 'https://en.wikipedia.org/wiki/Foo_(bar).', [bare('https://en.wikipedia.org/wiki/Foo_(bar)'), t('.')]],
    ['quotes around a url', '"https://a.com"', [t('"'), bare('https://a.com'), t('"')]],
    ['url stops at whitespace and newline', 'https://a.com\nnext', [bare('https://a.com'), br, t('next')]],
    ['url stops at <', 'https://a.com<b', [bare('https://a.com'), t('<b')]],
    ['upper-case scheme', 'HTTPS://A.COM', [bare('HTTPS://A.COM')]],
    ['markers around a url belong to the emphasis', '**https://a.com**', [strong(bare('https://a.com'))]],
    ['spoiler around a url', '||https://a.com||', [spoiler(bare('https://a.com'))]],
    ['italic around a url', '_https://a.com_', [em(bare('https://a.com'))]],
    ['markers inside a url without an open emphasis stay', 'https://a.com/a*b*', [bare('https://a.com/a*b*')]],
    ['scheme without host is text', 'http://', [t('http://')]],
    ['non-http scheme is text', 'ftp://a.com', [t('ftp://a.com')]],
    ['suppressed-embed url', '<https://a.com/x>', [bare('https://a.com/x')]],
    ['suppressed-embed url with surrounding text', 'a <http://a.com> b', [t('a '), bare('http://a.com'), t(' b')]],
    ['angle brackets with a non-http scheme are text', '<ftp://a.com>', [t('<ftp://a.com>')]],
    ['masked link', '[text](https://a.com)', [masked('https://a.com', t('text'))]],
    ['masked link with <> destination', '[text](<https://a.com/a b>)', [masked('https://a.com/a b', t('text'))]],
    ['masked link with title', '[text](https://a.com "the title") x', [masked('https://a.com', t('text')), t(' x')]],
    ['masked link with single-quoted title', "[text](https://a.com 'the title')", [masked('https://a.com', t('text'))]],
    ['masked link with spaces inside the parentheses', '[a]( https://a.com )', [masked('https://a.com', t('a'))]],
    ['masked link with parentheses in the url', '[a](https://a.com/(x))', [masked('https://a.com/(x)', t('a'))]],
    ['masked link with formatted text', '[**a** b](https://a.com)', [masked('https://a.com', strong(t('a')), t(' b'))]],
    ['masked link inside bold', '**[a](https://a.com)**', [strong(masked('https://a.com', t('a')))]],
    ['bold opened inside the link text does not leak out', '[**a](https://a.com)**', [masked('https://a.com', t('**a')), t('**')]],
    ['bare url inside link text is not a nested link', '[see http://q.com](https://r.com)', [masked('https://r.com', t('see http://q.com'))]],
    ['javascript: destination is not a link', '[a](javascript:alert(1))', [t('[a](javascript:alert(1))')]],
    ['data: destination is not a link', '[a](data:text/html,x)', [t('[a](data:text/html,x)')]],
    ['relative destination is not a link', '[a](/foo)', [t('[a](/foo)')]],
    ['empty destination', '[a]()', [t('[a]()')]],
    ['empty link text', '[](https://a.com)', [t('[]('), bare('https://a.com'), t(')')]],
    ['blank link text', '[ ](https://a.com)', [t('[ ]('), bare('https://a.com'), t(')')]],
    ['brackets without a link', '[1] and [2]', [t('[1] and [2]')]],
    ['inner link wins, outer brackets are literal', '[x [y](https://a.com) z]', [t('[x '), masked('https://a.com', t('y')), t(' z]')]],
    ['two links', '[a](https://a.com) [b](https://b.com)', [masked('https://a.com', t('a')), t(' '), masked('https://b.com', t('b'))]],
    ['escaped parenthesis in the destination', '[a](https://a.com/\\))', [masked('https://a.com/)', t('a'))]],
  ]);
});

describe('parseMarkdown: mentions, emoji, timestamps', () => {
  run([
    ['user mention', '<@123456789012345678>', [user('123456789012345678')]],
    ['legacy nickname mention', '<@!42>', [user('42')]],
    ['role mention', '<@&99>', [{ type: 'mentionRole', id: '99' }]],
    ['channel mention', '<#7>', [{ type: 'mentionChannel', id: '7' }]],
    ['ids stay strings', '<@18446744073709551615>', [user('18446744073709551615')]],
    ['everyone and here', '@everyone @here', [{ type: 'mentionEveryone' }, t(' '), { type: 'mentionHere' }]],
    ['everyone followed by punctuation', 'hi @everyone!', [t('hi '), { type: 'mentionEveryone' }, t('!')]],
    ['@everyone inside a word is text', 'a@everyone', [t('a@everyone')]],
    ['@here inside an email address is text', 'me@here.com', [t('me@here.com')]],
    ['@heres is text', '@heres', [t('@heres')]],
    ['custom emoji', '<:smile:111>', [emoji('smile', '111')]],
    ['animated emoji', '<a:dance:222>', [emoji('dance', '222', true)]],
    ['emoji between text', 'a<:x_y:1>b', [t('a'), emoji('x_y', '1'), t('b')]],
    ['timestamp default style', '<t:1700000000>', [{ type: 'timestamp', unix: 1700000000, style: 'f' }]],
    ['timestamp with style', '<t:1700000000:R>', [{ type: 'timestamp', unix: 1700000000, style: 'R' }]],
    ['negative timestamp', '<t:-86400:d>', [{ type: 'timestamp', unix: -86400, style: 'd' }]],
    [
      'all documented styles',
      '<t:0:t><t:0:T><t:0:D><t:0:F>',
      [
        { type: 'timestamp', unix: 0, style: 't' },
        { type: 'timestamp', unix: 0, style: 'T' },
        { type: 'timestamp', unix: 0, style: 'D' },
        { type: 'timestamp', unix: 0, style: 'F' },
      ],
    ],
    ['slash command mention becomes plain text', 'use </help:123> or </foo bar:456>', [t('use /help or /foo bar')]],
    ['mention inside bold', '**<@1>**', [strong(user('1'))]],
    ['mention is not parsed inside code', '`<@1>`', [code('<@1>')]],
  ]);
});

describe('parseMarkdown: block level', () => {
  describe('headings and subtext', () => {
    run([
      ['h1', '# Title', [heading(1, t('Title'))]],
      ['h2', '## Title', [heading(2, t('Title'))]],
      ['h3', '### Title', [heading(3, t('Title'))]],
      ['h4 is not supported', '#### Title', [t('#### Title')]],
      ['no space is not a heading', '#Title', [t('#Title')]],
      ['empty heading is text', '# ', [t('# ')]],
      ['inline formatting in headings', '# a **b**', [heading(1, t('a '), strong(t('b')))]],
      ['heading then text has no extra br', '# H\ntext', [heading(1, t('H')), t('text')]],
      ['text then heading has no extra br', 'text\n# H', [t('text'), heading(1, t('H'))]],
      ['blank line after a heading is kept', '# H\n\ntext', [heading(1, t('H')), br, t('text')]],
      ['heading marker mid-line is text', 'a # b', [t('a # b')]],
      ['subtext', '-# small', [subtext(t('small'))]],
      ['subtext with formatting', '-# sub **b**', [subtext(t('sub '), strong(t('b')))]],
      ['"-#" without a space is text', '-#x', [t('-#x')]],
    ]);
  });

  describe('block quotes', () => {
    run([
      ['single line', '> quote', [quote(t('quote'))]],
      ['consecutive lines form one quote', '> a\n> b', [quote(t('a'), br, t('b'))]],
      ['text after a quote', '> a\nafter', [quote(t('a')), t('after')]],
      ['text before a quote', 'before\n> a', [t('before'), quote(t('a'))]],
      ['blank line separates quotes', '> a\n\n> b', [quote(t('a')), quote(t('b'))]],
      ['">" without a space is text', '>text', [t('>text')]],
      ['">" in the middle of a line is text', 'a > b', [t('a > b')]],
      ['>>> quotes the rest of the message', '>>> a\nb\nc', [quote(t('a'), br, t('b'), br, t('c'))]],
      ['text before >>>', 'x\n>>> a\nb', [t('x'), quote(t('a'), br, t('b'))]],
      ['quotes do not nest', '> > a', [quote(t('> a'))]],
      ['> inside >>> is literal', '>>> a\n> b', [quote(t('a'), br, t('> b'))]],
      ['formatting inside a quote', '> **b** _i_', [quote(strong(t('b')), t(' '), em(t('i')))]],
      ['list inside a quote', '> - a\n> - b', [quote(ul([t('a')], [t('b')]))]],
      ['heading inside a quote', '> # H', [quote(heading(1, t('H')))]],
      ['code block inside a quote', '> ```\n> code\n> ```\nafter', [quote(fence('code')), t('after')]],
      ['leading spaces before the marker', '  > a', [quote(t('a'))]],
    ]);
  });

  describe('lists', () => {
    run([
      ['dash list', '- a\n- b', [ul([t('a')], [t('b')])]],
      ['asterisk list', '* a\n* b', [ul([t('a')], [t('b')])]],
      ['mixed bullets stay one list', '- a\n* b', [ul([t('a')], [t('b')])]],
      ['ordered list', '1. a\n2. b', [ol(1, [t('a')], [t('b')])]],
      ['ordered list keeps its first number', '3. a\n4. b', [ol(3, [t('a')], [t('b')])]],
      ['inline formatting in items', '- **a** b', [ul([strong(t('a')), t(' b')])]],
      ['nested by indentation', '- a\n  - b\n    - c\n- d', [ul([t('a'), ul([t('b'), ul([t('c')])])], [t('d')])]],
      ['ordered inside unordered', '- a\n  1. b\n  2. c', [ul([t('a'), ol(1, [t('b')], [t('c')])])]],
      ['switching list type starts a new list', '- a\n1. b\n- c', [ul([t('a')]), ol(1, [t('b')]), ul([t('c')])]],
      ['dedent returns to the outer list', '- a\n  - b\n- c', [ul([t('a'), ul([t('b')])], [t('c')])]],
      ['text ends a list', '- a\ntext\n- b', [ul([t('a')]), t('text'), ul([t('b')])]],
      ['paragraph before a list', 'x\n- a', [t('x'), ul([t('a')])]],
      ['"*italic*" is not a list', '*not list*', [em(t('not list'))]],
      ['marker without a space is text', '-a', [t('-a')]],
      ['empty item is text', '- ', [t('- ')]],
      ['marker without a space after the dot', '1.x', [t('1.x')]],
      ['huge numbers are text', '12345678901. x', [t('12345678901. x')]],
      ['bold at the start of a line is not a list', '**a** b', [strong(t('a')), t(' b')]],
    ]);
  });

  describe('fenced code blocks', () => {
    run([
      ['with language', '```js\nconst a = 1;\n```', [fence('const a = 1;', 'js')]],
      ['without language', '```\ncode\n```', [fence('code')]],
      ['one line', '```code```', [fence('code')]],
      [
        'content is verbatim (markdown, # and > lines)',
        '```\n# not heading\n> not quote\n**not bold** <@1>\n```',
        [fence('# not heading\n> not quote\n**not bold** <@1>')],
      ],
      ['indentation inside is kept', '```\n  indented\n    more\n```', [fence('  indented\n    more')]],
      ['blank lines inside are kept', '```\na\n\nb\n```', [fence('a\n\nb')]],
      ['language only counts before a newline', '```js code```', [fence('js code')]],
      ['language characters', '```c++\nx\n```', [fence('x', 'c++')]],
      ['text after the closing fence', '```a```b', [fence('a'), t('b')]],
      ['newline after the closing fence is consumed', '```a```\nb', [fence('a'), t('b')]],
      ['text before the fence on its own line', 'a\n```x```\nb', [t('a'), fence('x'), t('b')]],
      ['text before the fence on the same line', 'run ```x``` now', [t('run '), fence('x'), t(' now')]],
      ['block markers inside a mid-line fence stay literal', 'x ```\n# c\n```', [t('x '), fence('# c')]],
      ['indented opening fence', '  ```x```', [fence('x')]],
      ['two blocks', '```a```\n```b```', [fence('a'), fence('b')]],
      ['unclosed fence is not a block', '```\ncode', [t('```'), br, t('code')]],
      ['empty fence is not a block', '``` ```', [code(' ')]],
      ['trailing blank lines inside are dropped', '```\ncode\n\n\n```', [fence('code')]],
      ['fence then list', '```a```\n- x', [fence('a'), ul([t('x')])]],
      ['backticks inside text need a closing fence', 'a ``` b', [t('a ``` b')]],
    ]);
  });
});

describe('parseMarkdown: mixed Korean text', () => {
  run([
    ['bold Korean', '**안녕** 세계', [strong(t('안녕')), t(' 세계')]],
    ['bold attached to Korean particles', '**한글**은 좋다', [strong(t('한글')), t('은 좋다')]],
    ['italic Korean', '*기울임*과 _이탤릭_', [em(t('기울임')), t('과 '), em(t('이탤릭'))]],
    ['Korean letters are not ASCII word characters (Discord quirk)', '이_것_저', [t('이'), em(t('것')), t('저')]],
    ['spoiler Korean', '||스포일러|| 입니다', [spoiler(t('스포일러')), t(' 입니다')]],
    ['strike Korean', '~~취소선~~', [strike(t('취소선'))]],
    ['Korean heading', '# 제목', [heading(1, t('제목'))]],
    ['Korean list', '- 사과\n- 배', [ul([t('사과')], [t('배')])]],
    ['Korean with url', '여기 https://a.com/한글 참고', [t('여기 '), bare('https://a.com/한글'), t(' 참고')]],
    ['Korean around mention and emoji', '<@1> 님 <:ok:5> 확인', [user('1'), t(' 님 '), emoji('ok', '5'), t(' 확인')]],
    ['Korean emoji names are not valid emoji syntax', '<:웃음:5>', [t('<:웃음:5>')]],
    ['Korean text with escaped markers', '\\*별표\\* 와 **굵게**', [t('*별표* 와 '), strong(t('굵게'))]],
  ]);
});

describe('parseMarkdown: nesting depth is capped', () => {
  it('never produces nodes deeper than MAX_DEPTH, however many markers are nested', () => {
    const alternating = '*_'.repeat(5000) + 'a' + '_*'.repeat(5000);
    expect(maxDepth(parseMarkdown(alternating))).toBeLessThanOrEqual(MAX_DEPTH);
    const mixed = '**__~~||*'.repeat(500) + 'a' + '*||~~__**'.repeat(500);
    expect(maxDepth(parseMarkdown(mixed))).toBeLessThanOrEqual(MAX_DEPTH);
  });

  it('parses reasonable nesting fully', () => {
    const nodes = parseMarkdown('**a __b *c ~~d ||e||~~ c* b__ a**');
    expect(maxDepth(nodes)).toBe(5);
  });

  it('flattens lists deeper than the cap instead of nesting without bound', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n');
    const nodes = parseMarkdown(lines);
    expect(maxDepth(nodes)).toBeLessThanOrEqual(MAX_DEPTH + 1);
    const texts = JSON.stringify(nodes).match(/item \d+/g) ?? [];
    expect(texts).toHaveLength(200); // nothing is lost, only flattened
  });

  it('keeps the content of everything it refuses to nest', () => {
    const plain = (nodes: MdNode[]): string =>
      nodes.map((n) => ('text' in n ? n.text : 'children' in n ? plain(n.children) : '')).join('');
    const input = '*_'.repeat(100) + 'payload' + '_*'.repeat(100);
    expect(plain(parseMarkdown(input))).toContain('payload');
  });
});

describe('parseMarkdown: robustness', () => {
  const makeRandom = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const randomString = (rnd: () => number, alphabet: string[], maxLen: number) => {
    let s = '';
    const len = 1 + Math.floor(rnd() * maxLen);
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    return s;
  };

  /** Everything a reader can see as literal text (code, link text ...), in document order. */
  const literal = (nodes: MdNode[]): string =>
    nodes
      .map((n): string => {
        switch (n.type) {
          case 'text':
          case 'inlineCode':
            return n.text;
          case 'codeBlock':
            return (n.lang ?? '') + n.text; // the language tag is consumed from the opening line
          case 'list':
            return n.items.map(literal).join('');
          case 'br':
            return '\n';
          default:
            return 'children' in n ? literal(n.children) : '';
        }
      })
      .join('');

  const assertNormalized = (nodes: MdNode[]): void => {
    let previousWasText = false;
    for (const node of nodes) {
      if (node.type === 'text') {
        expect(node.text).not.toBe('');
        expect(previousWasText).toBe(false);
      }
      previousWasText = node.type === 'text';
      if ('children' in node) assertNormalized(node.children);
      if (node.type === 'list') node.items.forEach(assertNormalized);
    }
  };

  it('never throws on arbitrary special-character soup', () => {
    const alphabet = ['*', '_', '~', '|', '`', '[', ']', '(', ')', '<', '>', '@', '#', '-', '\\', '\n', ' ', 'a', ':', '1', 'h', 'http://', '```', '> ', '- ', '<@1>', '<t:1>'];
    const rnd = makeRandom(12345);
    for (let round = 0; round < 1500; round++) {
      const s = randomString(rnd, alphabet, 80);
      expect(() => parseMarkdown(s), JSON.stringify(s)).not.toThrow();
    }
  });

  it('never loses or reorders visible characters (only markers are consumed)', () => {
    // no 'h', digits, '<' or '@': nothing in this alphabet can turn into a url, list number, mention or timestamp
    const alphabet = ['*', '**', '_', '__', '~~', '||', '`', '``', '```', '[', ']', '(', ')', '>', '>>> ', '# ', '- ', '-# ', '\\', '\n', ' ', 'a', 'b', 'c'];
    const rnd = makeRandom(987654321);
    const letters = (s: string) => s.replace(/[^abc]/g, '');
    for (let round = 0; round < 3000; round++) {
      const s = randomString(rnd, alphabet, 70);
      const nodes = parseMarkdown(s);
      expect(letters(literal(nodes)), JSON.stringify(s)).toBe(letters(s));
    }
  });

  it('always returns normalised trees: no empty or adjacent text nodes, bounded depth', () => {
    const alphabet = ['*', '_', '~~', '||', '`', '[', ']', '(', ')', '<@1>', ':', '\\', '\n', ' ', 'a', 'b', 'https://a.com', '> ', '- ', '# ', '```'];
    const rnd = makeRandom(424242);
    for (let round = 0; round < 3000; round++) {
      const s = randomString(rnd, alphabet, 70);
      const nodes = parseMarkdown(s);
      assertNormalized(nodes);
      expect(maxDepth(nodes), JSON.stringify(s)).toBeLessThanOrEqual(MAX_DEPTH + 1);
    }
  });

  it('is deterministic and does not keep state between calls', () => {
    const input = '**a** [b](https://c.com) `d` ||e|| <@1>';
    expect(parseMarkdown(input)).toEqual(parseMarkdown(input));
    parseMarkdown('[x](https://a.com');
    expect(parseMarkdown(input)).toEqual(parseMarkdown(input));
  });

  it('merges adjacent text so renderers get one node per run', () => {
    expect(parseMarkdown('a * b _ c ~ d | e [ f')).toEqual([t('a * b _ c ~ d | e [ f')]);
  });
});

describe('emoji helpers', () => {
  it.each([
    ['one custom emoji', '<:a:1>', true, 1],
    ['custom emoji separated by spaces', '<:a:1> <:b:2>  <a:c:3>', true, 3],
    ['unicode emoji', '😀', true, 1],
    ['unicode emoji with whitespace and newlines', '😀 😎\n🎉', true, 3],
    ['mixed custom and unicode', '😀<:a:1>', true, 2],
    ['skin tone modifier', '👍🏽', true, 1],
    ['zwj family', '👨‍👩‍👧‍👦', true, 1],
    ['flags (regional indicators)', '🇰🇷🇺🇸', true, 2],
    ['keycap', '1️⃣', true, 1],
    ['variation selector', '❤️', true, 1],
    ['text with emoji is not jumbo', 'hi 😀', false, 0],
    ['bold emoji is not jumbo', '**😀**', false, 0],
    ['mention is not jumbo', '<@1>', false, 0],
    ['plain text', 'hello', false, 0],
    ['digits are not emoji', '123', false, 0],
    ['copyright sign is not an emoji', '©', false, 0],
    ['empty', '', false, 0],
    ['whitespace only', '  \n ', false, 0],
  ])('%s', (_name, input, only, count) => {
    expect(isEmojiOnly(parseMarkdown(input))).toBe(only);
    expect(emojiOnlyCount(parseMarkdown(input))).toBe(count);
  });

  it('allows up to 27 emoji and no more', () => {
    expect(isEmojiOnly(parseMarkdown('😀'.repeat(27)))).toBe(true);
    expect(isEmojiOnly(parseMarkdown('😀'.repeat(28)))).toBe(false);
    expect(emojiOnlyCount(parseMarkdown('😀'.repeat(28)))).toBe(28);
    expect(isEmojiOnly(parseMarkdown('<:a:1>'.repeat(27)))).toBe(true);
    expect(isEmojiOnly(parseMarkdown('<:a:1>'.repeat(28)))).toBe(false);
  });

  it('splits text into emoji and non-emoji runs', () => {
    expect(splitUnicodeEmoji('a😀b👍🏽')).toEqual([
      { text: 'a', emoji: false },
      { text: '😀', emoji: true },
      { text: 'b', emoji: false },
      { text: '👍🏽', emoji: true },
    ]);
    expect(splitUnicodeEmoji('plain')).toEqual([{ text: 'plain', emoji: false }]);
    expect(splitUnicodeEmoji('')).toEqual([]);
    expect(splitUnicodeEmoji('©')).toEqual([{ text: '©', emoji: false }]);
  });
});
