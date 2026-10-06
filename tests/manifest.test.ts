import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { DEV_SERVER_ORIGIN as DEV_RELOAD_ORIGIN } from '@/background/devReload';
import { buildManifest, DEV_SERVER_ORIGIN } from '@/manifest';
import { DISCORD_ORIGINS } from '@/shared';
import { DEV_SERVER_PORT } from '../scripts/dev-server.mjs';

const DISCORD_MATCHES = ['https://discord.com/*', 'https://ptb.discord.com/*', 'https://canary.discord.com/*'];
const PROD_CSP =
  "script-src 'self'; object-src 'self'; " +
  "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net; " +
  "connect-src 'self' https://discord.com https://*.discord.com https://cdn.discordapp.com https://media.discordapp.net";
const ICONS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

const fromRoot = (path: string) => new URL(`../${path}`, import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(fromRoot(path), 'utf8')) as Record<string, { message: string }>;

describe('buildManifest("production") is the manifest of docs/PLAN.md §9', () => {
  const manifest = buildManifest('production');

  it('matches the plan exactly', () => {
    expect(manifest).toEqual({
      manifest_version: 3,
      name: '__MSG_extName__',
      version: pkg.version,
      description: '__MSG_extDescription__',
      default_locale: 'ko',
      minimum_chrome_version: '120',
      icons: ICONS,
      action: { default_title: '__MSG_extName__', default_popup: 'popup.html', default_icon: ICONS },
      background: { service_worker: 'background.js', type: 'module' },
      permissions: ['storage', 'webRequest', 'downloads', 'offscreen', 'notifications'],
      host_permissions: [
        'https://discord.com/*',
        'https://ptb.discord.com/*',
        'https://canary.discord.com/*',
        'https://discordapp.com/*',
        'https://cdn.discordapp.com/*',
        'https://media.discordapp.net/*',
      ],
      content_scripts: [{ matches: DISCORD_MATCHES, js: ['content.js'], run_at: 'document_idle', all_frames: false }],
      commands: {
        'add-current-chat': { suggested_key: { default: 'Alt+Shift+D' }, description: '__MSG_cmdAddCurrent__' },
      },
      content_security_policy: { extension_pages: PROD_CSP },
    });
  });

  it('is plain JSON (what chrome.runtime.getManifest() would return)', () => {
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });

  it('takes its version from package.json (2.x for V2)', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.version).toMatch(/^2\.\d+\.\d+$/);
  });

  it('has no localhost anywhere', () => {
    expect(JSON.stringify(manifest)).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it('runs one content script on the three Discord origins and exposes nothing to web pages (no web_accessible_resources)', () => {
    expect(DISCORD_MATCHES).toEqual(DISCORD_ORIGINS.map((origin) => `${origin}/*`));
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts![0]!.matches).toEqual(DISCORD_MATCHES);
    expect(manifest).not.toHaveProperty('web_accessible_resources');
    expect(buildManifest('development')).not.toHaveProperty('web_accessible_resources');
  });

  it('is a fresh object on every call (callers may mutate it)', () => {
    expect(buildManifest('production')).not.toBe(manifest);
    expect(buildManifest('production').host_permissions).not.toBe(manifest.host_permissions);
  });
});

describe('buildManifest("development")', () => {
  const production = buildManifest('production');
  const development = buildManifest('development');

  it('adds the dev-server host permission and connect-src source, nothing else', () => {
    expect(development.host_permissions).toEqual([...production.host_permissions!, 'http://localhost:5858/*']);
    expect(development.content_security_policy?.extension_pages).toBe(`${PROD_CSP} http://localhost:5858`);

    const withoutDevAdditions = structuredClone(development);
    withoutDevAdditions.host_permissions = production.host_permissions;
    withoutDevAdditions.content_security_policy = production.content_security_policy;
    expect(withoutDevAdditions).toEqual(production);
  });

  it('keeps script-src and object-src to the extension itself', () => {
    const directives = development.content_security_policy!.extension_pages!.split('; ');
    expect(directives).toContain("script-src 'self'");
    expect(directives).toContain("object-src 'self'");
    expect(directives.join(';')).not.toContain('unsafe-eval');
  });
});

describe('the dev-server address agrees everywhere', () => {
  it('manifest.ts, devReload.ts and scripts/dev-server.mjs use port 5858', () => {
    expect(DEV_SERVER_PORT).toBe(5858);
    expect(DEV_SERVER_ORIGIN).toBe(`http://localhost:${DEV_SERVER_PORT}`);
    expect(DEV_RELOAD_ORIGIN).toBe(DEV_SERVER_ORIGIN);
  });
});

describe('_locales', () => {
  const ko = readJson('public/_locales/ko/messages.json');
  const en = readJson('public/_locales/en/messages.json');
  const used = [...JSON.stringify(buildManifest('production')).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((match) => match[1]!);

  it('both languages define every message the manifest uses', () => {
    expect([...new Set(used)].sort()).toEqual(['cmdAddCurrent', 'extDescription', 'extName']);
    for (const messages of [ko, en]) for (const key of used) expect(messages[key]?.message.trim()).toBeTruthy();
  });

  it('both languages define the same keys', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  });

  it('use the agreed names and respect the Chrome length limits', () => {
    expect(ko.extName!.message).toBe('디스코드 채팅 추출기 v2');
    expect(en.extName!.message).toBe('Discord Chat Extractor v2');
    expect(ko.cmdAddCurrent!.message).toBe('보고 있는 채팅을 다운로드 목록에 추가하거나 빼기');
    expect(en.cmdAddCurrent!.message).toBe('Add or remove the chat you are viewing in the download list');
    for (const messages of [ko, en]) {
      expect(messages.extName!.message.length).toBeLessThanOrEqual(75);
      expect(messages.extDescription!.message.length).toBeLessThanOrEqual(132);
    }
  });
});

describe('icons', () => {
  it.each(Object.entries(ICONS))('public/%s: a PNG of exactly that size', (size, path) => {
    const bytes = readFileSync(fromRoot(`public/${path}`));
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([Number(size), Number(size)]);
  });
});
