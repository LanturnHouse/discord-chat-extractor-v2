/**
 * The extension manifest (docs/PLAN.md §9). Pure data: no Chrome or Node APIs, so vite.config.ts (which writes the result to
 * dist/manifest.json), the tests and the build scripts can all import it. Owned by the main agent.
 *
 * Relative imports only: vite.config.ts loads this file before any `@` alias exists.
 */
import pkg from '../package.json' with { type: 'json' };
import { DISCORD_ORIGINS } from './shared/defaults.ts';

export type BuildMode = 'development' | 'production';

/** Where `npm run dev` serves `GET /build-id` (scripts/dev-server.mjs, src/background/devReload.ts). Development builds only. */
export const DEV_SERVER_ORIGIN = 'http://localhost:5858';

/** Match patterns of the Discord web client (the content script runs there; nothing of the extension is exposed to web pages). */
const DISCORD_MATCHES = DISCORD_ORIGINS.map((origin) => `${origin}/*`);

const ICONS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

function contentSecurityPolicy(mode: BuildMode): string {
  const connect = ["'self'", 'https://discord.com', 'https://cdn.discordapp.com', 'https://media.discordapp.net'];
  if (mode === 'development') connect.push(DEV_SERVER_ORIGIN);
  return [
    "script-src 'self'",
    "object-src 'self'",
    "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net",
    `connect-src ${connect.join(' ')}`,
  ].join('; ');
}

/**
 * The manifest object for `mode`. Development adds the dev-server host permission and CSP source; nothing else differs.
 * There is deliberately no `web_accessible_resources`: no extension file can be loaded by a web page (docs/PLAN.md §9).
 */
export function buildManifest(mode: BuildMode): chrome.runtime.ManifestV3 {
  const hostPermissions = [
    ...DISCORD_MATCHES,
    'https://cdn.discordapp.com/*',
    'https://media.discordapp.net/*',
  ];
  if (mode === 'development') hostPermissions.push(`${DEV_SERVER_ORIGIN}/*`);

  return {
    manifest_version: 3,
    name: '__MSG_extName__',
    version: pkg.version,
    description: '__MSG_extDescription__',
    default_locale: 'ko',
    minimum_chrome_version: '120',
    icons: ICONS,
    action: {
      default_title: '__MSG_extName__',
      default_popup: 'popup.html',
      default_icon: ICONS,
    },
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    permissions: ['storage', 'webRequest', 'downloads', 'offscreen', 'notifications'],
    host_permissions: hostPermissions,
    content_scripts: [
      {
        matches: DISCORD_MATCHES,
        js: ['content.js'],
        run_at: 'document_idle',
        all_frames: false,
      },
    ],
    commands: {
      'add-current-chat': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: '__MSG_cmdAddCurrent__',
      },
    },
    content_security_policy: {
      extension_pages: contentSecurityPolicy(mode),
    },
  };
}
