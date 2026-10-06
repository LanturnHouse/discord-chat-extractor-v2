import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildManifest } from '@/manifest';
import { verifyDist } from '../../scripts/verify-dist.mjs';

// The real `vite build` of this repo (the same command as `npm run build` / `npm run build:dev`, run in a child process so
// nothing leaks into this worker), into a temp directory. Guards vite.config.ts: page placement, the single-file worker and
// content script, manifest generation, `__DEV__` replacement.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');

function build(mode: 'production' | 'development'): string {
  const outDir = mkdtempSync(join(tmpdir(), `dce-build-${mode}-`));
  const env = { ...process.env };
  delete env.NODE_ENV; // let vite pick it, exactly as it does under `npm run build`
  execFileSync(process.execPath, [viteBin, 'build', '--mode', mode, '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: ROOT,
    env,
    stdio: 'pipe',
  });
  return outDir;
}

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

const outputs: Partial<Record<'production' | 'development', string>> = {};
beforeAll(() => {
  outputs.production = build('production');
  outputs.development = build('development');
}, 120_000);
afterAll(() => {
  for (const dir of Object.values(outputs)) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.each(['production', 'development'] as const)('vite build (%s)', (mode) => {
  const dist = () => outputs[mode]!;

  it('produces a dist/ that scripts/verify-dist.mjs accepts', () => {
    const { problems, notes } = verifyDist({ distDir: dist(), rootDir: ROOT });
    expect(problems).toEqual([]);
    expect(notes[0]).toBe(mode === 'production' ? 'production build' : 'DEVELOPMENT build (dev-server permission present; not for packing)');
  });

  it('has the files of docs/PLAN.md §9 and nothing else at the top', () => {
    expect(readdirSync(dist()).sort()).toEqual(['_locales', 'assets', 'background.js', 'content.js', 'icons', 'manifest.json', 'offscreen.html', 'popup.html']);
    expect(filesUnder(join(dist(), '_locales')).sort()).toEqual(['en/messages.json', 'ko/messages.json']);
    expect(filesUnder(join(dist(), 'icons')).sort()).toEqual(['icon128.png', 'icon16.png', 'icon32.png', 'icon48.png']);
  });

  it('writes manifest.json from src/manifest.ts', () => {
    expect(JSON.parse(readFileSync(join(dist(), 'manifest.json'), 'utf8'))).toEqual(buildManifest(mode));
  });

  it('puts the pages at the root with their code and shared chunks under assets/ (absolute /assets URLs)', () => {
    for (const page of ['popup', 'offscreen']) {
      const html = readFileSync(join(dist(), `${page}.html`), 'utf8');
      expect(html).toMatch(new RegExp(`<script type="module" crossorigin src="/assets/${page}-[\\w-]+\\.js"></script>`));
      expect(html).toContain('<div id="root"></div>');
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/); // no inline script
    }
    expect(filesUnder(join(dist(), 'assets')).every((file) => /\.(?:js|css)$/.test(file))).toBe(true);
  });

  it('replaces __DEV__ everywhere', () => {
    for (const file of filesUnder(dist()).filter((name) => name.endsWith('.js'))) {
      expect(readFileSync(join(dist(), file), 'utf8'), file).not.toMatch(/\b__DEV__\b/);
    }
  });

  it('background.js is one ES-module file and content.js one classic script, neither importing anything', () => {
    const background = readFileSync(join(dist(), 'background.js'), 'utf8');
    const content = readFileSync(join(dist(), 'content.js'), 'utf8');
    expect(background).not.toMatch(/^\s*import[\s{*"']/m);
    expect(content).not.toMatch(/\b(?:import|export)\b\s*[{*"'(]/);
    expect(existsSync(join(dist(), 'assets', 'background.js'))).toBe(false);
  });
});

describe('vite build: development-only code', () => {
  it('is in the development build (dev reload, content marker)', () => {
    const background = readFileSync(join(outputs.development!, 'background.js'), 'utf8');
    const content = readFileSync(join(outputs.development!, 'content.js'), 'utf8');
    expect(background).toContain('localhost:5858');
    expect(background).toContain('dce.dev.reloadTabs');
    expect(content).toMatch(/^\(function\(\) \{/); // an IIFE
    expect(content).toContain('[dce] content script (placeholder) loaded');
  });

  it('is not in the production build', () => {
    for (const file of filesUnder(outputs.production!).filter((name) => /\.(?:js|html|json)$/.test(name))) {
      const text = readFileSync(join(outputs.production!, file), 'utf8');
      expect(text, file).not.toMatch(/localhost|dce\.dev\.|startDevReload|build-id/);
    }
  });
});
