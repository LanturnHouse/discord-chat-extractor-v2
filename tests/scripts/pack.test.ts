import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { PackError, packDist } from '../../scripts/pack.mjs';
import { createDistFixture, type DistFixture } from './distFixture';

let fixture: DistFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe('packDist', () => {
  it('zips the CONTENTS of dist/ (manifest.json at the zip root) into discord-chat-extractor-v2-<version>.zip', () => {
    fixture = createDistFixture('production');
    const { zipPath, fileCount, bytes } = packDist({ rootDir: fixture.root });
    expect(zipPath).toBe(join(fixture.root, 'discord-chat-extractor-v2-2.0.0.zip'));
    expect(bytes).toBeGreaterThan(0);

    const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
    const names = Object.keys(entries).sort();
    expect(names).toHaveLength(fileCount);
    expect(names).toContain('manifest.json');
    expect(names).toContain('background.js');
    expect(names).toContain('content.js');
    expect(names).toContain('popup.html');
    expect(names).toContain('_locales/ko/messages.json');
    expect(names).toContain('icons/icon128.png');
    expect(names.every((name) => !name.startsWith('dist/') && !name.includes('\\'))).toBe(true);
    expect(new TextDecoder().decode(entries['manifest.json'])).toBe(fixture.read('manifest.json'));
  });

  it('is deterministic: the same dist/ gives byte-identical archives', () => {
    fixture = createDistFixture('production');
    const first = readFileSync(packDist({ rootDir: fixture.root }).zipPath);
    const second = readFileSync(packDist({ rootDir: fixture.root }).zipPath);
    expect(second.equals(first)).toBe(true);
  });

  it('refuses a development build (it would ship the dev-server permission and reload code)', () => {
    fixture = createDistFixture('development');
    expect(() => packDist({ rootDir: fixture!.root })).toThrow(PackError);
    expect(() => packDist({ rootDir: fixture!.root })).toThrow(/development build/);
    expect(existsSync(join(fixture.root, 'discord-chat-extractor-v2-2.0.0.zip'))).toBe(false);
  });

  it('refuses a dist/ that fails verification and lists why', () => {
    fixture = createDistFixture('production');
    fixture.remove('content.js');
    expect(() => packDist({ rootDir: fixture!.root })).toThrow(/FAIL content\.js is missing[\s\S]*not packing/);
    expect(existsSync(join(fixture.root, 'discord-chat-extractor-v2-2.0.0.zip'))).toBe(false);
  });

  it('refuses when there is no dist/', () => {
    fixture = createDistFixture('production');
    fixture.remove('.');
    expect(() => packDist({ rootDir: fixture!.root })).toThrow(/dist\/ does not exist - run "npm run build" first/);
  });
});
