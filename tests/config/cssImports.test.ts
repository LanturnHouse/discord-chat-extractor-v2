import { describe, expect, it } from 'vitest';
import inlineCss from './fixtures/sample.css?inline';
import rawCss from './fixtures/sample.css?raw';

// Runs in the default (node) environment; a file that needs a DOM opts in per file (see jsdom.test.tsx).
describe('test environment', () => {
  it('imports CSS as a string with ?inline (the content script ships its CSS that way) and ?raw (HTML export)', () => {
    expect(typeof inlineCss).toBe('string');
    expect(inlineCss).toContain('.dce-sample');
    expect(typeof rawCss).toBe('string');
    expect(rawCss).toContain('.dce-sample { color: red; }');
  });

  it('defines __DEV__ as false (production code paths)', () => {
    expect(typeof __DEV__).toBe('boolean');
    expect(__DEV__).toBe(false);
  });

  it('runs in node by default', () => {
    expect(typeof document).toBe('undefined');
  });
});
