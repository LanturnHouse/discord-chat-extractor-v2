import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The contracts in src/shared are copied VERBATIM from docs/PLAN.md §5.1-§5.3 (only comments and `import type` lines may
// differ). §5.4 (defaults, `resolveItemSettings`) is prose in the plan: tests/shared/defaults.test.ts pins its values. This test
// fails when either side is edited without the other, so the main agent sees the drift immediately.
const plan = readFileSync(new URL('../../docs/PLAN.md', import.meta.url), 'utf8');

/** The first ```ts fence after the "### <section> " heading. */
function planBlock(section: string): string {
  const heading = plan.indexOf(`\n### ${section} `);
  if (heading < 0) throw new Error(`docs/PLAN.md has no "### ${section}" heading (renamed? update tests/shared/contractSync.test.ts)`);
  const open = plan.indexOf('```ts', heading);
  const close = plan.indexOf('```', open + 5);
  if (open < 0 || close < 0) throw new Error(`docs/PLAN.md §${section} has no \`\`\`ts block`);
  return plan.slice(open + 5, close);
}

/** Code without comments, `import type` lines and layout: one entry per statement/member, so a diff points at the difference. */
function statements(code: string): string[] {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '') // block and JSDoc comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // line comments (but not the // of a URL)
    .replace(/^\s*import\s+type\s[^;]*;/gm, '') // the imports the plan leaves out
    .split(/;|(?<=[{}])/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** The file's lines without what P1a added around the plan's code: the header JSDoc and the `import type` lines. */
function planLines(source: string): string[] {
  return source
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
    .replace(/^import type [^;]*;\n/m, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
    .split('\n');
}

describe('src/shared contracts match docs/PLAN.md §5.1-§5.3', () => {
  const contracts = [
    ['5.1', 'types.ts'],
    ['5.2', 'storageKeys.ts'],
    ['5.3', 'messages.ts'],
  ] as const;
  const read = (file: string) => readFileSync(new URL(`../../src/shared/${file}`, import.meta.url), 'utf8');

  it.each(contracts)('§%s = src/shared/%s (declarations)', (section, file) => {
    const expected = statements(planBlock(section));
    expect(expected.length).toBeGreaterThan(5); // the extraction itself works
    expect(statements(read(file))).toEqual(expected);
  });

  it.each(contracts)('§%s = src/shared/%s (verbatim, comments included)', (section, file) => {
    const expected = planBlock(section).trim().split('\n').map((line) => line.trimEnd());
    expect(planLines(read(file))).toEqual(expected);
  });

  it('the extraction notices a real difference', () => {
    expect(statements('export type A = 1 | 2; // x')).not.toEqual(statements('export type A = 1 | 3; // x'));
    expect(statements('export type A = 1; // x\n/** doc */ import type { B } from "./b";')).toEqual(statements('export type A = 1;'));
  });
});
