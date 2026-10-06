import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, type BuildMode } from '@/manifest';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** A tiny extension page; `script` is the URL of its module script (none = no script tag). */
export function pageHtml(script: string | null): string {
  return [
    '<!doctype html>',
    '<html lang="ko">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <title>page</title>',
    ...(script ? [`    <script type="module" crossorigin src="${script}"></script>`] : []),
    '  </head>',
    '  <body><div id="root"></div></body>',
    '</html>',
    '',
  ].join('\n');
}

export interface DistFixture {
  /** Repo-like root holding package.json and dist/ (and, after packing, the zip). */
  root: string;
  dist: string;
  write(relativePath: string, content: string | Uint8Array): void;
  read(relativePath: string): string;
  remove(relativePath: string): void;
  /** Edit dist/manifest.json in place. */
  patchManifest(patch: (manifest: any) => void): void;
  cleanup(): void;
}

/** A minimal but complete dist/ in a temp directory that `verifyDist` accepts: tests then break one thing at a time. */
export function createDistFixture(mode: BuildMode = 'production'): DistFixture {
  const root = mkdtempSync(join(tmpdir(), 'dce-dist-'));
  const dist = join(root, 'dist');
  const manifest = buildManifest(mode);

  const fixture: DistFixture = {
    root,
    dist,
    write(relativePath, content) {
      const file = join(dist, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    read: (relativePath) => readFileSync(join(dist, relativePath), 'utf8'),
    remove: (relativePath) => rmSync(join(dist, relativePath), { recursive: true, force: true }),
    patchManifest(patch) {
      const current = JSON.parse(fixture.read('manifest.json'));
      patch(current);
      fixture.write('manifest.json', JSON.stringify(current, null, 2));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: manifest.version }));
  fixture.write('manifest.json', JSON.stringify(manifest, null, 2));
  fixture.write('background.js', 'console.log("background");\n');
  fixture.write('content.js', '(function(){console.log("content")})();\n');
  fixture.write('popup.html', pageHtml('/assets/popup-AAAA.js'));
  fixture.write('offscreen.html', pageHtml('/assets/offscreen-AAAA.js'));
  fixture.write('assets/popup-AAAA.js', 'import{a as e}from"./shared-AAAA.js";console.log(e);\n');
  fixture.write('assets/offscreen-AAAA.js', 'document.documentElement.dataset.x="1";\n');
  fixture.write('assets/shared-AAAA.js', 'var n=1;export{n as a};\n');
  cpSync(join(REPO, 'public', 'icons'), join(dist, 'icons'), { recursive: true });
  cpSync(join(REPO, 'public', '_locales'), join(dist, '_locales'), { recursive: true });
  return fixture;
}
