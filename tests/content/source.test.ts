import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Static guards for the rules of CLAUDE.md / docs/PLAN.md §3, §8 that no behavioural test can prove: the content script makes
// no API calls, never touches the session storage, ships no remote code, and its entry exports nothing.
const SRC = fileURLToPath(new URL('../../src/content/', import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const files = filesUnder(SRC).map((path) => ({ name: relative(SRC, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));
const code = files.filter((file) => /\.(?:ts|tsx)$/.test(file.name));

/** Source without comments, so a rule that is only MENTIONED in a comment does not trip a guard. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('src/content stays inside its rules', () => {
  it('has the files this test expects to scan', () => {
    expect(code.length).toBeGreaterThan(15);
    expect(files.some((file) => file.name === 'styles.css')).toBe(true);
  });

  it('index.ts exports nothing (an IIFE with exports assigns a global in the isolated world)', () => {
    const index = files.find((file) => file.name === 'index.ts')!;
    expect(stripComments(index.text)).not.toMatch(/\bexport\b/);
  });

  it('makes no network calls of its own', () => {
    for (const file of code) {
      expect(stripComments(file.text), file.name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|\bEventSource\b|sendBeacon|navigator\.sendBeacon|\bnew\s+Worker\b|importScripts/);
    }
  });

  it('never reads or writes the session storage (the token lives there), nor sync storage', () => {
    for (const file of code) {
      expect(stripComments(file.text), file.name).not.toMatch(/storage\s*\.\s*(?:session|sync|managed)\b|SESSION\b|\bsession\s*:/);
    }
  });

  it('knows no token, authorization header or cookie', () => {
    for (const file of code) {
      expect(stripComments(file.text), file.name).not.toMatch(/authorization|document\.cookie|localStorage|sessionStorage|dce\.token|tokenCapturedAt|Bearer/i);
    }
  });

  it('sends only the five allowed message types (PLAN §8)', () => {
    const types = new Set<string>();
    for (const file of code) for (const match of stripComments(file.text).matchAll(/type:\s*'([a-z]+\/[A-Za-z]+)'/g)) types.add(match[1]!);
    expect(Array.from(types).sort()).toEqual(['inject/health', 'queue/addCategory', 'queue/addGuild', 'queue/groupInfo', 'queue/toggle']);
  });

  it('writes to chrome.storage.local in one place only, and only the theme and the class cache', () => {
    const writers = code.filter((file) => /writeLocal\s*\(|storage\.local\.set/.test(stripComments(file.text)));
    expect(writers.map((file) => file.name).sort()).toEqual(['app.ts', 'platform.ts']);
    const app = stripComments(files.find((file) => file.name === 'app.ts')!.text);
    const keys = Array.from(app.matchAll(/writeLocal\(\{\s*\[(LOCAL\.[A-Za-z]+)\]/g)).map((match) => match[1]);
    expect(keys.sort()).toEqual(['LOCAL.classCache', 'LOCAL.theme']);
  });

  it('builds its nodes with createElement and textContent only: names from Discord`s DOM never reach an HTML parser', () => {
    for (const file of code) {
      expect(stripComments(file.text), file.name).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write|DOMParser|createContextualFragment/);
    }
  });

  it('does not add classes to <html> (React-Helmet owns it)', () => {
    for (const file of code) {
      expect(stripComments(file.text), file.name).not.toMatch(/documentElement\s*\.\s*(?:classList|className)\s*(?:\.\s*(?:add|toggle|replace)|=[^=])|documentElement\s*\.\s*setAttribute/);
    }
  });

  it('imports its stylesheet as text and nothing else needs a second output file', () => {
    const overlay = files.find((file) => file.name === 'ui/overlay.ts')!;
    expect(overlay.text).toContain("from '../styles.css?inline'");
    for (const file of code) {
      expect(file.text, file.name).not.toMatch(/import\s+['"][^'"]+\.css['"]/);
    }
  });

  it('keeps every Discord selector in dom/selectors.ts: no class-stem or data-attribute strings elsewhere', () => {
    const allowed = new Set(['dom/selectors.ts', 'config.ts', 'styles.css']);
    for (const file of code) {
      if (allowed.has(file.name)) continue;
      const text = stripComments(file.text);
      expect(text, file.name).not.toMatch(
        /data-list-item-id|data-dnd-name|aria-expanded|channels___|private-channels|iconItem|actionIcon|iconsContainer|closeButton|closeIcon|typeThread|iconVisibility|children_|inviteButton|headerContent|guildDropdown/,
      );
    }
  });

  it('option #17 is retired (PLAN §2): no code path reads showQueuedIndicator, and no per-state "force" attribute exists', () => {
    for (const file of files) {
      const text = file.name.endsWith('.css') ? file.text.replace(/\/\*[\s\S]*?\*\//g, '') : stripComments(file.text);
      expect(text, file.name).not.toMatch(/showQueuedIndicator|showIndicator|data-dce-force|FORCE_ATTR/);
    }
  });

  it('the stylesheet has no remote URL and no import', () => {
    const css = files.find((file) => file.name === 'styles.css')!.text;
    expect(css).not.toMatch(/url\(|@import/);
  });
});
