import { beforeAll, describe, expect, it } from 'vitest';
import { parseMarkdown } from '@/lib/markdown/parse';
import { renderHtml } from '@/lib/markdown/renderHtml';
import { renderText } from '@/lib/markdown/renderText';
import type { MarkdownContext } from '@/lib/markdown/types';
import { fastestRunMs } from './timing';

/**
 * Message content is attacker-controlled: nothing below may take anywhere near a quadratic amount of time.
 * Each input is ~100k characters (a Discord message is at most 4000). Parse + both string renderers take 1-50 ms per
 * case on a quiet machine; a quadratic parser needs seconds. The ceiling sits in between with a wide margin for a busy
 * CI box, and a case only fails when every one of its runs is over it (see fastestRunMs).
 */
const LIMIT_MS = 500;
const N = 100_000;

const ctx: MarkdownContext = {
  names: { user: () => undefined, channel: () => undefined, role: () => undefined },
  locale: 'en',
  timeZone: 'UTC',
};

function parseAndRender(input: string): void {
  const nodes = parseMarkdown(input);
  renderHtml(nodes, ctx);
  renderText(nodes, ctx);
}

function bestOf3(input: string): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    parseAndRender(input);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

const rep = (unit: string, chars = N): string => unit.repeat(Math.ceil(chars / unit.length));

const pathological: Record<string, string> = {
  // the inputs called out in the task
  '100k asterisks': rep('*'),
  '100k asterisks followed by text': rep('*') + 'a',
  '100k opening brackets': rep('['),
  '100k brackets then closers': rep('[', N / 2) + rep(']', N / 2),
  '10k ">" lines': rep('>\n', 20_000),
  '10k "> text" lines': rep('> a\n', 40_000),
  '50k "||"': rep('||'),
  '50k "||" with content': rep('||a', 99_000),
  deeply_nested_lists: Array.from({ length: 1500 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n'),
  // emphasis machinery
  'alternating *a pairs': rep('*a'),
  'a* pairs': rep('a*'),
  'openers then closers': rep('*a ', N / 2) + rep('a* ', N / 2),
  'underscore openers': rep('_a '),
  'only underscores': rep('_'),
  'only tildes': rep('~~'),
  'nested alternating emphasis': rep('*_', 10_000) + 'a' + rep('_*', 10_000),
  'nested all five markers': rep('**__~~||*', 36_000) + 'a' + rep('*||~~__**', 36_000),
  'every special character': rep('*_~|[`<'),
  // links
  'link destinations that never close': rep('[a]('),
  'link titles that never close': rep('[a](x "'),
  'angle destinations that never close': rep('[a](<'),
  'valid links': rep('[a](https://a.com) '),
  // the label of a masked link is scanned for addresses (see linkHost.ts)
  'masked links whose text is a domain': rep('[a.bc](https://a.com) '),
  'masked links that look spoofed': rep('[discord.com](https://evil.example) '),
  'masked link with a label of dots': '[' + rep('a.') + '](https://a.com)',
  'masked link with a label of dotted names': '[' + rep('a.b ') + '](https://a.com)',
  'masked link with one endless dotted name': '[' + rep('a.b') + '](https://a.com)',
  'masked link with a label of dots and a last stop': '[' + rep('a.') + '!](https://a.com)',
  'masked link with a label of userinfo names': '[' + rep('a.b@') + '](https://a.com)',
  'masked link repeating the target host': '[' + rep('a.com ') + '](https://a.com)',
  'masked link with an endless word before one dot': '[' + rep('a') + '.b](https://a.com)',
  'bare urls that are invalid': rep('http://['),
  'http:// floods': rep('http://'),
  'http:// followed by spaces': rep('http:// '),
  'one giant url': 'https://a.com/' + rep('a(', N),
  'many urls': rep('https://a.com/x. '),
  'trailing parentheses on a url': 'https://a.com/' + rep(')'),
  // backticks and fences
  'only backticks': rep('`'),
  'backtick runs of growing length': rep('` `` ``` ```` ``````` '),
  'alternating backtick runs': rep('`a``b```c````d'),
  'fence openers': rep('```a'),
  'fence openers on their own lines': rep('``` x\n'),
  'mid-line fence openers with no closer': rep('x ```\n'),
  'many tiny fences': rep('```a```\n'),
  // angle brackets, mentions, misc
  'only "<"': rep('<'),
  'unterminated autolinks': rep('<http://a'),
  'unterminated mentions': rep('<@1'),
  'many mentions and emoji': rep('<@1><#2><:a:3> '),
  'many timestamps': rep('<t:4> ', 30_000),
  'only "h"': rep('h'),
  'only backslashes': rep('\\'),
  '@everyone floods': rep('@everyone'),
  'only newlines': rep('\n'),
  'only spaces': rep(' '),
  'only hashes': rep('#'),
  'many headings': rep('# a\n', 80_000),
  'many list items': rep('- a\n', 80_000),
  'many quoted list items': rep('> - a\n', 60_000),
  'many ordered items': rep('1. a\n', 80_000),
  'nested quotes chain': rep('> ', N),
  'unicode emoji': rep('😀'),
};

describe('markdown performance on adversarial input', () => {
  beforeAll(() => {
    // JIT / regex compilation warm-up so the first case is not penalised for loading code
    renderText(parseMarkdown('**a** [b](https://c.com) `d` ||e|| <@1> # h\n- x\n> q\n```js\nx\n```'), ctx);
  });

  it.each(Object.entries(pathological))('%s', (_name, input) => {
    expect(fastestRunMs(LIMIT_MS, () => parseAndRender(input))).toBeLessThan(LIMIT_MS);
  });

  it('scales linearly: ten times the input does not take a hundred times as long', () => {
    for (const unit of ['*a', '[a](', '||a', '`a``b```', '> a\n', '_a ', '<@1']) {
      // linear would be ~10x; quadratic ~100x. 40x leaves room for timer noise, but a few-millisecond baseline can still be
      // hit by a GC pause or a busy CPU (the suite runs files in parallel), so a noisy measurement gets two more tries:
      // a genuinely quadratic parser fails every attempt.
      let ratio = Infinity;
      for (let attempt = 0; attempt < 3 && ratio >= 40; attempt += 1) {
        const small = Math.max(bestOf3(rep(unit, 20_000)), 1);
        const large = bestOf3(rep(unit, 200_000));
        ratio = large / small;
      }
      expect(ratio, unit).toBeLessThan(40);
    }
  });

  it('renders deeply nested lists without overflowing the stack', () => {
    const input = Array.from({ length: 5000 }, (_, i) => `${' '.repeat(i)}- x`).join('\n');
    expect(() => {
      const nodes = parseMarkdown(input);
      renderHtml(nodes, ctx);
      renderText(nodes, ctx);
    }).not.toThrow();
  });
});
