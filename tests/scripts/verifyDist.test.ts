import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest } from '@/manifest';
import {
  cspProblems,
  dynamicImports,
  importSpecifiers,
  isDevManifest,
  leadingImports,
  parseCsp,
  verifyDist,
} from '../../scripts/verify-dist.mjs';
import { createDistFixture, pageHtml, type DistFixture } from './distFixture';

const PROD_CSP = buildManifest('production').content_security_policy!.extension_pages!;
const DEV_CSP = buildManifest('development').content_security_policy!.extension_pages!;

let fixture: DistFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function verify(f: DistFixture) {
  return verifyDist({ distDir: f.dist, rootDir: f.root });
}

describe('verifyDist: a good dist/', () => {
  it('passes for a production build', () => {
    fixture = createDistFixture('production');
    const { problems, notes } = verify(fixture);
    expect(problems).toEqual([]);
    expect(notes).toContain('production build');
    expect(notes.join('\n')).toMatch(/content\.js is a single classic-script IIFE/);
    expect(notes.join('\n')).toMatch(/background\.js is a single self-contained module/);
  });

  it('passes for a development build and says so', () => {
    fixture = createDistFixture('development');
    const { problems, notes } = verify(fixture);
    expect(problems).toEqual([]);
    expect(notes.some((note) => note.startsWith('DEVELOPMENT build'))).toBe(true);
  });

  it('accepts an empty content.js (the placeholder content script)', () => {
    fixture = createDistFixture();
    fixture.write('content.js', '');
    const { problems, notes } = verify(fixture);
    expect(problems).toEqual([]);
    expect(notes).toContain('content.js is empty (placeholder content script)');
  });

  it('accepts a bundler-style IIFE with comments first', () => {
    fixture = createDistFixture();
    fixture.write('content.js', '//#region src/content/index.ts\n/* x */\n(function() {\n\tconsole.log(1);\n})();\n');
    expect(verify(fixture).problems).toEqual([]);
  });

  it('reports a missing dist/ directory', () => {
    fixture = createDistFixture();
    const { problems } = verifyDist({ distDir: join(fixture.root, 'nope'), rootDir: fixture.root });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not exist - run "npm run build" first/);
  });
});

describe('verifyDist: files and layout', () => {
  const cases: [string, (f: DistFixture) => void, RegExp][] = [
    ['no manifest', (f) => f.remove('manifest.json'), /manifest\.json is missing/],
    ['manifest is not JSON', (f) => f.write('manifest.json', '{ nope'), /manifest\.json is not valid JSON/],
    ['no background.js', (f) => f.remove('background.js'), /background\.js is missing/],
    ['no content.js', (f) => f.remove('content.js'), /content\.js is missing/],
    ['no popup.html', (f) => f.remove('popup.html'), /popup\.html is missing/],
    ['no offscreen.html', (f) => f.remove('offscreen.html'), /offscreen\.html is missing/],
    ['no icons', (f) => f.remove('icons'), /icons\/icon16\.png does not exist/],
    ['pages left under src/ (not flattened)', (f) => f.write('src/popup/popup.html', pageHtml(null)), /unexpected entry at the top of dist\/: src/],
    ['a stray file at the top', (f) => f.write('notes.txt', 'x'), /unexpected entry at the top of dist\/: notes\.txt/],
    ['an HTML page inside assets/', (f) => f.write('assets/extra.html', pageHtml(null)), /assets\/extra\.html: HTML pages belong at the dist root/],
    ['a source map in a production build', (f) => f.write('assets/popup-AAAA.js.map', '{}'), /source map in a production build/],
    ['manifest version differs from package.json', (f) => f.patchManifest((m) => (m.version = '1.0.0')), /manifest version 1\.0\.0 != package\.json version/],
    ['manifest_version 2', (f) => f.patchManifest((m) => (m.manifest_version = 2)), /manifest_version must be 3/],
    ['service worker is not background.js', (f) => f.patchManifest((m) => (m.background.service_worker = 'sw.js')), /background\.service_worker must be "background\.js"/],
    ['service worker is not a module', (f) => f.patchManifest((m) => delete m.background.type), /background\.type must be "module"/],
    ['popup is not popup.html', (f) => f.patchManifest((m) => (m.action.default_popup = 'other.html')), /action\.default_popup must be "popup\.html"/],
  ];

  it.each(cases)('flags %s', (_name, mutate, expected) => {
    fixture = createDistFixture();
    mutate(fixture);
    expect(verify(fixture).problems.join('\n')).toMatch(expected);
  });

  it('reports a leftover modal.html once, with the reason, and not as a generic stray file', () => {
    fixture = createDistFixture();
    fixture.write('modal.html', pageHtml('/assets/popup-AAAA.js'));
    expect(verify(fixture).problems).toEqual(['modal.html must not exist: the in-page settings modal was removed (docs/PLAN.md §2, §9)']);
  });

  it('flags an icon whose size is not the one the manifest declares', () => {
    fixture = createDistFixture();
    copyFileSync(join(fixture.dist, 'icons', 'icon16.png'), join(fixture.dist, 'icons', 'icon32.png'));
    expect(verify(fixture).problems.join('\n')).toMatch(/icon icons\/icon32\.png is 16x16, manifest says 32x32/);
  });

  it('flags an icon that is not a PNG', () => {
    fixture = createDistFixture();
    fixture.write('icons/icon48.png', 'not a png');
    expect(verify(fixture).problems.join('\n')).toMatch(/icon icons\/icon48\.png is not a PNG/);
  });

  it('allows source maps in a development build', () => {
    fixture = createDistFixture('development');
    fixture.write('assets/popup-AAAA.js.map', '{}');
    expect(verify(fixture).problems).toEqual([]);
  });
});

describe('verifyDist: manifest policy', () => {
  const cases: [string, (m: any) => void, RegExp][] = [
    ['an extra permission', (m) => m.permissions.push('tabs'), /unexpected permissions tabs/],
    ['optional permissions', (m) => (m.optional_permissions = ['history']), /optional_permissions/],
    ['<all_urls> host permission', (m) => m.host_permissions.push('<all_urls>'), /unexpected host_permissions <all_urls>/],
    ['a broad host permission', (m) => m.host_permissions.push('https://*/*'), /unexpected host_permissions https:\/\/\*\/\*/],
    ['a localhost host permission other than the dev server', (m) => m.host_permissions.push('http://localhost:9999/*'), /unexpected host_permissions http:\/\/localhost:9999/],
    ['a content script on another site', (m) => m.content_scripts[0].matches.push('https://example.com/*'), /content_scripts\[0\]\.matches/],
    ['a second content script', (m) => m.content_scripts.push({ matches: ['https://discord.com/*'], js: ['x.js'] }), /exactly one content_scripts entry/],
    ['content script css', (m) => (m.content_scripts[0].css = ['content.css']), /content_scripts\[0\]\.css must be empty/],
    ['a different content script file', (m) => (m.content_scripts[0].js = ['other.js']), /content_scripts\[0\]\.js must be \["content\.js"\]/],
    ['run_at document_start', (m) => (m.content_scripts[0].run_at = 'document_start'), /run_at must be "document_idle"/],
    ['all_frames', (m) => (m.content_scripts[0].all_frames = true), /all_frames must be false/],
    ['main world', (m) => (m.content_scripts[0].world = 'MAIN'), /world must be ISOLATED/],
    ['the former modal web_accessible_resources', (m) => (m.web_accessible_resources = [{ resources: ['modal.html', 'assets/*'], matches: ['https://discord.com/*'] }]), /web_accessible_resources must not exist/],
    ['web_accessible_resources open to every site', (m) => (m.web_accessible_resources = [{ resources: ['assets/*'], matches: ['<all_urls>'] }]), /web_accessible_resources must not exist/],
    ['an empty web_accessible_resources list', (m) => (m.web_accessible_resources = []), /web_accessible_resources must not exist/],
    ['externally_connectable', (m) => (m.externally_connectable = { matches: ['https://*/*'] }), /externally_connectable/],
    ['a missing locale message', (m) => (m.name = '__MSG_doesNotExist__'), /_locales\/ko\/messages\.json has no "doesNotExist" \(the manifest uses it\)/],
  ];

  it.each(cases)('flags %s', (_name, mutate, expected) => {
    fixture = createDistFixture();
    fixture.patchManifest(mutate);
    expect(verify(fixture).problems.join('\n')).toMatch(expected);
  });

  it('flags an un-localised default locale directory', () => {
    fixture = createDistFixture();
    fixture.patchManifest((m) => (m.default_locale = 'fr'));
    expect(verify(fixture).problems.join('\n')).toMatch(/default_locale "fr" has no _locales\/fr\//);
  });

  it('flags a locale that lacks a key another locale has', () => {
    fixture = createDistFixture();
    const en = JSON.parse(fixture.read('_locales/en/messages.json'));
    delete en.cmdAddCurrent;
    fixture.write('_locales/en/messages.json', JSON.stringify(en));
    expect(verify(fixture).problems.join('\n')).toMatch(/_locales\/en\/messages\.json has no "cmdAddCurrent" \(the manifest uses it\)/);
  });

  it('flags a locale folder that is missing and a name that is too long for Chrome', () => {
    fixture = createDistFixture();
    fixture.remove('_locales/en');
    expect(verify(fixture).problems.join('\n')).toMatch(/_locales\/en\/ is missing/);

    fixture.write('_locales/ko/messages.json', JSON.stringify({ extName: { message: 'x'.repeat(76) }, extDescription: { message: 'd' }, cmdAddCurrent: { message: 'c' } }));
    expect(verify(fixture).problems.join('\n')).toMatch(/extName is longer than the 75 characters/);
  });

  it('flags a production manifest that asks for the dev server', () => {
    fixture = createDistFixture();
    fixture.patchManifest((m) => m.host_permissions.push('http://localhost:5858/*'));
    // such a manifest IS a development build: verification then expects the dev CSP source as well
    expect(isDevManifest(JSON.parse(fixture.read('manifest.json')))).toBe(true);
  });
});

describe('verifyDist: pages', () => {
  const cases: [string, (f: DistFixture) => void, RegExp][] = [
    ['an inline script', (f) => f.write('popup.html', '<html><head><script>alert(1)</script></head></html>'), /popup\.html: inline <script>/],
    ['an inline event handler', (f) => f.write('popup.html', '<html><body onclick="x()"></body></html>'), /popup\.html: inline event handler "onclick"/],
    ['a javascript: link', (f) => f.write('popup.html', '<a href="javascript:alert(1)">x</a>'), /javascript: URL/],
    ['a remote script', (f) => f.write('popup.html', pageHtml('https://cdn.example.com/x.js')), /popup\.html: remote URL in src of <script>: https:\/\/cdn\.example\.com\/x\.js/],
    ['a protocol-relative script', (f) => f.write('popup.html', pageHtml('//cdn.example.com/x.js')), /remote URL in src/],
    ['a remote stylesheet', (f) => f.write('popup.html', '<link rel="stylesheet" href="https://fonts.example.com/a.css">'), /remote URL in href of <link>/],
    ['a remote image', (f) => f.write('popup.html', '<img src="http://example.com/a.png">'), /remote URL in src of <img>/],
    ['a classic (non-module) script', (f) => f.write('popup.html', '<script src="/assets/popup-AAAA.js"></script>'), /is not type="module"/],
    ['a script that does not exist', (f) => f.write('popup.html', pageHtml('/assets/missing.js')), /popup\.html: <script> \/assets\/missing\.js does not exist/],
    ['a script outside dist/', (f) => f.write('popup.html', pageHtml('/../outside.js')), /points outside dist\//],
  ];

  it.each(cases)('flags %s', (_name, mutate, expected) => {
    fixture = createDistFixture();
    mutate(fixture);
    expect(verify(fixture).problems.join('\n')).toMatch(expected);
  });

  it('accepts relative script URLs', () => {
    fixture = createDistFixture();
    fixture.write('popup.html', pageHtml('./assets/popup-AAAA.js'));
    expect(verify(fixture).problems).toEqual([]);
  });
});

describe('verifyDist: scripts', () => {
  const cases: [string, (f: DistFixture) => void, RegExp][] = [
    ['a static import in background.js', (f) => f.write('background.js', 'import{a}from"./assets/shared-AAAA.js";console.log(a);'), /background\.js imports "\.\/assets\/shared-AAAA\.js"/],
    ['a side-effect import in background.js', (f) => f.write('background.js', 'import"./x.js";'), /background\.js imports "\.\/x\.js"/],
    ['a dynamic import in background.js', (f) => f.write('background.js', 'const m = await import("./x.js");'), /background\.js imports "\.\/x\.js"/],
    ['an import() with an expression in background.js', (f) => f.write('background.js', 'import(name)'), /dynamic import\(\) with a non-literal specifier/],
    ['an import statement in content.js', (f) => f.write('content.js', 'import{a}from"./x.js";(function(){})();'), /content\.js is not a classic script/],
    ['an export statement in content.js', (f) => f.write('content.js', '(function(){})();export{};'), /content\.js is not a classic script/],
    ['import.meta in content.js', (f) => f.write('content.js', '(function(){ console.log(import.meta.url) })();'), /content\.js is not a classic script/],
    ['top-level await in content.js', (f) => f.write('content.js', 'await 1;'), /content\.js is not a classic script/],
    ['a dynamic import in content.js', (f) => f.write('content.js', '(function(){ import("./x.js") })();'), /content\.js contains a dynamic import\(\)/],
    ['top-level variables in content.js', (f) => f.write('content.js', 'var leaked = 1;\n(function(){})();'), /does not start with an IIFE wrapper/],
    ['a syntax error in content.js', (f) => f.write('content.js', '(function(){'), /content\.js is not a classic script/],
    ['eval in a chunk', (f) => f.write('assets/popup-AAAA.js', 'import{a}from"./shared-AAAA.js";eval("1");'), /assets\/popup-AAAA\.js: uses eval\(\)/],
    ['new Function in a chunk', (f) => f.write('assets/shared-AAAA.js', 'export const a = new Function("return 1");'), /uses new Function\(\)/],
    ['a WebSocket in the worker', (f) => f.write('background.js', 'new WebSocket("wss://x")'), /background\.js: uses a WebSocket/],
    ['importScripts in the worker', (f) => f.write('background.js', 'importScripts("x.js")'), /uses importScripts\(\)/],
    ['a Worker in a page chunk', (f) => f.write('assets/popup-AAAA.js', 'import{a}from"./shared-AAAA.js";new Worker("w.js")'), /uses a Worker/],
    ['a remote import in a chunk', (f) => f.write('assets/popup-AAAA.js', 'import{a}from"https://cdn.example.com/x.js";'), /imports "https:\/\/cdn\.example\.com\/x\.js" - only relative imports/],
    ['a missing shared chunk', (f) => f.remove('assets/shared-AAAA.js'), /imports "\.\/shared-AAAA\.js" which does not exist/],
    ['a remote url() in CSS', (f) => f.write('assets/popup-AAAA.css', '.a{background:url(https://example.com/x.png)}'), /popup-AAAA\.css: uses a remote url\(\)/],
    ['a remote @import in CSS', (f) => f.write('assets/popup-AAAA.css', '@import "https://example.com/x.css";'), /uses a remote @import/],
  ];

  it.each(cases)('flags %s', (_name, mutate, expected) => {
    fixture = createDistFixture();
    mutate(fixture);
    expect(verify(fixture).problems.join('\n')).toMatch(expected);
  });

  it('flags development-only code in a production build, but not in a development build', () => {
    fixture = createDistFixture('production');
    fixture.write('background.js', 'fetch("http://localhost:5858/build-id");');
    expect(verify(fixture).problems.join('\n')).toMatch(/background\.js: contains "localhost:5858" - development-only code in a production build/);
    fixture.write('background.js', 'chrome.storage.local.set({"dce.dev.buildId":1});');
    expect(verify(fixture).problems.join('\n')).toMatch(/contains "dce\.dev\."/);

    const dev = createDistFixture('development');
    dev.write('background.js', 'fetch("http://localhost:5858/build-id");');
    expect(verify(dev).problems).toEqual([]);
    dev.cleanup();
  });

  it('does not mistake strings that look like imports (React development warnings) for imports', () => {
    fixture = createDistFixture('development');
    fixture.write('assets/shared-AAAA.js', 'var n=1;export{n as a};var hint="import MyComponent from \'./MyComponent\'; lazy(() => import(\'./MyComponent\'))";\n');
    expect(verify(fixture).problems).toEqual([]);
  });
});

describe('verifyDist: CSP', () => {
  const bad: [string, (csp: string) => string, RegExp][] = [
    ["'unsafe-eval' in script-src", (csp) => csp.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), /script-src allows 'unsafe-eval'/],
    ["'unsafe-inline' in script-src", (csp) => csp.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), /script-src allows 'unsafe-inline'/],
    ['a remote script source', (csp) => csp.replace("script-src 'self'", "script-src 'self' https://cdn.example.com"), /script-src allows https:\/\/cdn\.example\.com/],
    ['a wildcard connect-src', (csp) => csp.replace("connect-src 'self'", "connect-src 'self' *"), /connect-src allows every host/],
    ['https: in img-src', (csp) => csp.replace("img-src 'self'", "img-src 'self' https:"), /img-src allows every host/],
    ['another host in connect-src', (csp) => `${csp} https://evil.example`, /connect-src allows https:\/\/evil\.example/],
    ['localhost in a production connect-src', (csp) => `${csp} http://localhost:5858`, /connect-src allows http:\/\/localhost:5858 \(a local server\)/],
    ['ws: in connect-src', (csp) => `${csp} ws://example.com`, /connect-src allows ws:\/\/example\.com/],
    ['data: in connect-src', (csp) => `${csp} data:`, /connect-src allows data: \(only img-src may\)/],
    ['a frame-src with a remote host', (csp) => `${csp}; frame-src https://example.com`, /frame-src allows the remote source https:\/\/example\.com/],
    ['no script-src', (csp) => csp.replace("script-src 'self'; ", ''), /has no script-src directive/],
    ['no connect-src', (csp) => csp.replace(/; connect-src.*$/, ''), /has no connect-src directive/],
    ['no object-src', (csp) => csp.replace("object-src 'self'; ", ''), /has no object-src directive/],
  ];

  it('accepts the plan CSP in production and the dev CSP in development', () => {
    expect(cspProblems(PROD_CSP)).toEqual([]);
    expect(cspProblems(DEV_CSP, { dev: true })).toEqual([]);
  });

  it('flags the dev CSP when it appears in a production build', () => {
    expect(cspProblems(DEV_CSP).join('\n')).toMatch(/localhost/);
  });

  it.each(bad)('flags %s', (_name, mutate, expected) => {
    expect(cspProblems(mutate(PROD_CSP)).join('\n')).toMatch(expected);
  });

  it('flags a missing policy', () => {
    for (const csp of [undefined, '', '  ', 42]) expect(cspProblems(csp)).toHaveLength(1);
  });

  it('flags the CSP through verifyDist', () => {
    fixture = createDistFixture();
    fixture.patchManifest((m) => (m.content_security_policy.extension_pages = `${PROD_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")}`));
    expect(verify(fixture).problems.join('\n')).toMatch(/script-src allows 'unsafe-eval'/);
  });

  it('parseCsp: first occurrence of a directive wins, names are lower-cased', () => {
    const parsed = parseCsp("Script-Src 'self'; script-src https://x.example; img-src data: blob:");
    expect(parsed.get('script-src')).toEqual(["'self'"]);
    expect(parsed.get('img-src')).toEqual(['data:', 'blob:']);
  });
});

describe('import scanning', () => {
  it('leadingImports reads only the statements at the top of a bundled module', () => {
    const code = 'import{n as e,t}from"./jsx-runtime-C7VDZNfh.js";import"./side.js";import * as ns from \'./ns.js\';import def,{x}from`./d.js`;var a=1;import{late}from"./late.js";';
    expect(leadingImports(code)).toEqual(['./jsx-runtime-C7VDZNfh.js', './side.js', './ns.js', './d.js']);
  });

  it('leadingImports handles readable output, comments and no imports at all', () => {
    expect(leadingImports('// header\n/* c */\nimport { a } from "./a.js";\nimport {\n  b,\n  c\n} from "./b.js";\nconsole.log(1);')).toEqual(['./a.js', './b.js']);
    expect(leadingImports('console.log("import x from \\"./nope.js\\"");')).toEqual([]);
    expect(leadingImports('')).toEqual([]);
  });

  it('dynamicImports finds literal import() calls', () => {
    expect(dynamicImports('a(()=>import("./x-1.js"));b(import(`./y.js`));import(name);')).toEqual(['./x-1.js', './y.js']);
  });

  it('importSpecifiers combines both and flags non-literal dynamic imports', () => {
    expect(importSpecifiers('import"./a.js";x(import("./b.js"));')).toEqual({ specifiers: ['./a.js', './b.js'], hasDynamicNonLiteral: false });
    expect(importSpecifiers('import(file)').hasDynamicNonLiteral).toBe(true);
    expect(importSpecifiers('var a = 1;')).toEqual({ specifiers: [], hasDynamicNonLiteral: false });
  });
});
