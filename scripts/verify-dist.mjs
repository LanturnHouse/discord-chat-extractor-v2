// Sanity-checks a built extension in dist/ before it is loaded into Chrome or zipped (the checks that would otherwise only
// fail at runtime in Chrome):  node scripts/verify-dist.mjs [distDir]
// Exit code 1 (with a list of problems) when anything that would break the extension is found. Works for production and
// development builds (a development build is recognised by the dev-server permission in its manifest).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What dist/ may contain at its top level (anything else is a leftover, e.g. an un-flattened `src/` folder). */
const ROOT_ENTRIES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'offscreen.html', 'assets', 'icons', '_locales'];
const PAGES = ['popup.html', 'offscreen.html'];
/** Pages of an earlier plan revision that must not come back: there is no settings modal on Discord pages (docs/PLAN.md §2, §9). */
const REMOVED_PAGES = ['modal.html'];

const DISCORD_MATCHES = ['https://discord.com/*', 'https://ptb.discord.com/*', 'https://canary.discord.com/*'];
const ALLOWED_HOST_PERMISSIONS = [...DISCORD_MATCHES, 'https://cdn.discordapp.com/*', 'https://media.discordapp.net/*'];
const ALLOWED_PERMISSIONS = ['storage', 'webRequest', 'downloads', 'offscreen', 'notifications'];
const DEV_HOST = 'http://localhost:5858/*';
const DEV_CONNECT = 'http://localhost:5858';

/** The only remote sources the extension pages may talk to or load images from (docs/PLAN.md §9). */
const CSP_LOCAL_SOURCES = { 'script-src': ["'self'"], 'object-src': ["'self'", "'none'"], 'img-src': ["'self'", 'data:', 'blob:'], 'connect-src': ["'self'"] };
const CSP_REMOTE_SOURCES = {
  'script-src': [],
  'object-src': [],
  'img-src': ['https://cdn.discordapp.com', 'https://media.discordapp.net'],
  'connect-src': ['https://discord.com', 'https://cdn.discordapp.com', 'https://media.discordapp.net'],
};

const isRemote = (url) => /^(?:https?:)?\/\//i.test(url);
const isFile = (path) => existsSync(path) && statSync(path).isFile();
const posix = (path) => path.split(sep).join('/');

function readJson(path, problems, label) {
  if (!isFile(path)) {
    problems.push(`${label} is missing (${path})`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

/** Resolves a URL used inside the extension to a file path under distDir (null when it points outside). */
function resolveInDist(distDir, fromDir, ref) {
  const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
  const target = clean.startsWith('/') ? join(distDir, clean) : join(fromDir, clean);
  const rel = relative(distDir, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : target;
}

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** A development build (`npm run dev` / `build:dev`) asks for the dev-server host. Never ship one. */
export function isDevManifest(manifest) {
  return Array.isArray(manifest?.host_permissions) && manifest.host_permissions.includes(DEV_HOST);
}

// ---- manifest -------------------------------------------------------------------------------

/** Every file path a manifest points at, with a label for error messages. */
function manifestReferences(manifest) {
  const refs = [];
  const add = (label, path) => typeof path === 'string' && refs.push({ label, path: path.replace(/^\//, '') });
  add('background.service_worker', manifest.background?.service_worker);
  add('action.default_popup', manifest.action?.default_popup);
  add('options_page', manifest.options_page);
  add('options_ui.page', manifest.options_ui?.page);
  add('side_panel.default_path', manifest.side_panel?.default_path);
  const iconMaps = [
    ['icons', manifest.icons],
    ['action.default_icon', typeof manifest.action?.default_icon === 'object' ? manifest.action.default_icon : null],
  ];
  if (typeof manifest.action?.default_icon === 'string') add('action.default_icon', manifest.action.default_icon);
  for (const [label, map] of iconMaps) {
    for (const [size, path] of Object.entries(map ?? {})) add(`${label}[${size}]`, path);
  }
  for (const [i, script] of (manifest.content_scripts ?? []).entries()) {
    for (const path of [...(script.js ?? []), ...(script.css ?? [])]) add(`content_scripts[${i}]`, path);
  }
  return refs;
}

function checkIcons(distDir, manifest, problems) {
  const maps = [manifest.icons, typeof manifest.action?.default_icon === 'object' ? manifest.action.default_icon : null];
  for (const map of maps) {
    for (const [size, path] of Object.entries(map ?? {})) {
      const file = join(distDir, String(path).replace(/^\//, ''));
      if (!isFile(file)) continue; // already reported as a missing reference
      const bytes = readFileSync(file);
      if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        problems.push(`icon ${path} is not a PNG`);
      } else if (bytes.readUInt32BE(16) !== Number(size) || bytes.readUInt32BE(20) !== Number(size)) {
        problems.push(`icon ${path} is ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}, manifest says ${size}x${size}`);
      }
    }
  }
}

/** CSP string -> Map(directive name -> sources). The first occurrence of a directive wins, like in browsers. */
export function parseCsp(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/**
 * Problems of the `extension_pages` CSP: script/object sources are the extension itself only, no 'unsafe-eval', no wildcard
 * hosts, and the only remote hosts are the Discord ones of docs/PLAN.md §9 (images + connections). A development build may
 * also connect to the dev server; a production build may not mention a local server at all.
 * @returns {string[]}
 */
export function cspProblems(csp, { dev = false } = {}) {
  if (typeof csp !== 'string' || csp.trim() === '') {
    return ['manifest has no content_security_policy.extension_pages (Chrome would fall back to its default policy)'];
  }
  const problems = new Set();
  const directives = parseCsp(csp);

  for (const name of Object.keys(CSP_LOCAL_SOURCES)) {
    const sources = directives.get(name);
    if (!sources) {
      problems.add(`manifest CSP has no ${name} directive`);
      continue;
    }
    const allowed = [...CSP_LOCAL_SOURCES[name], ...CSP_REMOTE_SOURCES[name], ...(dev && name === 'connect-src' ? [DEV_CONNECT] : [])];
    if (sources.length === 0) problems.add(`manifest CSP ${name} is empty`);
    for (const source of sources) {
      if (!allowed.includes(source)) problems.add(`manifest CSP ${name} allows ${source}, which is not on the allow-list (${allowed.join(' ')})`);
    }
  }

  for (const [name, sources] of directives) {
    for (const source of sources) {
      const lower = source.toLowerCase();
      if (lower === "'unsafe-eval'") problems.add(`manifest CSP ${name} allows 'unsafe-eval'`);
      else if (lower === "'unsafe-inline'" && name !== 'style-src') problems.add(`manifest CSP ${name} allows 'unsafe-inline' (only style-src may)`);
      else if (['*', 'http:', 'https:', 'ws:', 'wss:'].includes(lower)) problems.add(`manifest CSP ${name} allows every host (${source})`);
      else if (['data:', 'blob:'].includes(lower) && name !== 'img-src') problems.add(`manifest CSP ${name} allows ${source} (only img-src may)`);
      else if (/localhost|127\.0\.0\.1|\[::1\]/.test(lower) && !(dev && name === 'connect-src' && source === DEV_CONNECT)) {
        problems.add(`manifest CSP ${name} allows ${source} (a local server) outside a development build`);
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !(name in CSP_REMOTE_SOURCES)) {
        problems.add(`manifest CSP ${name} allows the remote source ${source}`);
      }
    }
  }
  return [...problems];
}

function checkManifest(manifest, pkg, dev, problems, notes) {
  if (manifest.manifest_version !== 3) problems.push(`manifest_version must be 3, found ${manifest.manifest_version}`);
  if (pkg && manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} != package.json version ${pkg.version}`);
  else if (pkg) notes.push(`version ${manifest.version} matches package.json`);

  const extra = (list, allowed) => (list ?? []).filter((item) => !allowed.includes(item));
  const permissions = extra(manifest.permissions, ALLOWED_PERMISSIONS);
  if (permissions.length > 0) problems.push(`unexpected permissions ${permissions.join(', ')} (docs/PLAN.md §9; update scripts/verify-dist.mjs if intended)`);
  if (manifest.optional_permissions?.length > 0) problems.push('optional_permissions are not part of the plan');
  const hosts = extra(manifest.host_permissions, dev ? [...ALLOWED_HOST_PERMISSIONS, DEV_HOST] : ALLOWED_HOST_PERMISSIONS);
  if (hosts.length > 0) problems.push(`unexpected host_permissions ${hosts.join(', ')}${dev ? '' : ' (a production build may only ask for the Discord hosts)'}`);
  for (const [i, script] of (manifest.content_scripts ?? []).entries()) {
    const matches = extra(script.matches, DISCORD_MATCHES);
    if (matches.length > 0) problems.push(`content_scripts[${i}].matches may only be the Discord origins, found ${matches.join(', ')}`);
  }
  if (manifest.web_accessible_resources !== undefined) {
    problems.push('web_accessible_resources must not exist: no extension file is exposed to web pages (docs/PLAN.md §9)');
  }
  if (manifest.externally_connectable) problems.push('externally_connectable is not part of the plan');
  if (manifest.action?.default_popup !== 'popup.html') problems.push(`action.default_popup must be "popup.html", found ${JSON.stringify(manifest.action?.default_popup)}`);
  problems.push(...cspProblems(manifest.content_security_policy?.extension_pages, { dev }));
}

// ---- _locales -------------------------------------------------------------------------------

function checkLocales(distDir, manifest, problems, notes) {
  const localesDir = join(distDir, '_locales');
  if (!existsSync(localesDir)) {
    problems.push('_locales/ is missing');
    return;
  }
  const problemsBefore = problems.length;
  const locales = readdirSync(localesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const required of ['ko', 'en']) if (!locales.includes(required)) problems.push(`_locales/${required}/ is missing`);
  if (manifest.default_locale && !locales.includes(manifest.default_locale)) {
    problems.push(`default_locale "${manifest.default_locale}" has no _locales/${manifest.default_locale}/`);
  }

  const keys = new Map();
  for (const locale of locales) {
    const messages = readJson(join(localesDir, locale, 'messages.json'), problems, `_locales/${locale}/messages.json`);
    if (!messages) continue;
    keys.set(locale, new Set(Object.keys(messages)));
    for (const [key, value] of Object.entries(messages)) {
      if (typeof value?.message !== 'string' || value.message.trim() === '') problems.push(`_locales/${locale}: "${key}" has no message`);
    }
    if (messages.extName?.message?.length > 75) problems.push(`_locales/${locale}: extName is longer than the 75 characters Chrome allows`);
    if (messages.extDescription?.message?.length > 132) problems.push(`_locales/${locale}: extDescription is longer than the 132 characters Chrome allows`);
  }

  // Every locale needs every key the manifest references, and all locales need the same keys.
  const referenced = new Set([...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((m) => m[1]));
  const union = new Set([...referenced, ...[...keys.values()].flatMap((set) => [...set])]);
  for (const [locale, set] of keys) {
    for (const key of union) {
      if (set.has(key)) continue;
      problems.push(`_locales/${locale}/messages.json has no "${key}"${referenced.has(key) ? ' (the manifest uses it)' : ' (another locale has it)'}`);
    }
  }
  if (problems.length === problemsBefore) {
    notes.push(`_locales: ${[...keys.keys()].join(', ')} (${union.size} message(s) each, ${referenced.size} used by the manifest)`);
  }
}

// ---- pages ----------------------------------------------------------------------------------

function attributesOf(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[m[1].toLowerCase()] ??= m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/** One extension page: no inline script / handlers, no remote URLs, every local reference exists. */
function checkPage(distDir, name, problems, notes) {
  const htmlPath = join(distDir, name);
  if (!isFile(htmlPath)) {
    problems.push(`${name} is missing`);
    return;
  }
  const problemsBefore = problems.length;
  const html = readFileSync(htmlPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const references = [];
  let moduleScripts = 0;
  for (const [tag, tagName] of [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)].map((m) => [m[0], m[1].toLowerCase()])) {
    const attrs = attributesOf(tag.slice(tagName.length + 1));
    for (const attr of Object.keys(attrs)) {
      if (/^on[a-z]+$/.test(attr)) problems.push(`${name}: inline event handler "${attr}" on <${tagName}> (blocked by the extension CSP)`);
    }
    for (const attr of ['src', 'href', 'action', 'data', 'poster', 'srcset']) {
      if (attrs[attr] !== undefined && isRemote(attrs[attr])) problems.push(`${name}: remote URL in ${attr} of <${tagName}>: ${attrs[attr]}`);
    }
    if (/^\s*javascript:/i.test(attrs.href ?? '')) problems.push(`${name}: javascript: URL on <${tagName}>`);
    if (tagName === 'script') {
      if (attrs.src === undefined) problems.push(`${name}: inline <script> (blocked by the extension CSP)`);
      else {
        references.push({ tagName, url: attrs.src });
        if ((attrs.type ?? '').toLowerCase() === 'module') moduleScripts++;
        else problems.push(`${name}: <script src="${attrs.src}"> is not type="module"`);
      }
    } else if (tagName === 'link' && attrs.href !== undefined) {
      references.push({ tagName, url: attrs.href });
    } else if (['img', 'source', 'video', 'audio', 'iframe', 'embed'].includes(tagName) && attrs.src !== undefined) {
      references.push({ tagName, url: attrs.src });
    }
  }

  let local = 0;
  for (const { tagName, url } of references) {
    if (/^(?:data|blob):/i.test(url) || isRemote(url)) continue; // remote ones were reported above
    const target = resolveInDist(distDir, dirname(htmlPath), url);
    if (target === null) problems.push(`${name}: <${tagName}> ${url} points outside dist/`);
    else if (!isFile(target)) problems.push(`${name}: <${tagName}> ${url} does not exist in dist/`);
    else local++;
  }
  if (problems.length === problemsBefore) notes.push(`${name}: ${local} local file(s), ${moduleScripts} module script(s), no inline scripts, no remote URLs`);
}

// ---- scripts --------------------------------------------------------------------------------

/**
 * What the extension-page CSP cannot allow. Anything found here is either a bug waiting for the first run in Chrome (eval,
 * workers, importScripts) or network use beyond Discord that must be a deliberate decision.
 */
const FORBIDDEN_CODE = [
  [/\bnew\s+(?:Shared)?Worker\s*\(/, 'a Worker (the CSP offers no worker-src beyond the extension itself)'],
  [/\bimportScripts\s*\(/, 'importScripts()'],
  [/\bnew\s+WebSocket\s*\(/, 'a WebSocket (connect-src allows only the extension and Discord)'],
  [/\bnew\s+EventSource\s*\(/, 'an EventSource (connect-src allows only the extension and Discord)'],
  [/\bsendBeacon\s*\(/, 'navigator.sendBeacon (no traffic besides the Discord API requests)'],
  [/\beval\s*\(/, "eval() (the CSP has no 'unsafe-eval')"],
  [/\bnew\s+Function\s*\(/, "new Function() (the CSP has no 'unsafe-eval')"],
];
const FORBIDDEN_CSS = [
  [/url\(\s*["']?(?:https?:)?\/\//i, 'a remote url() (only the extension itself and data: images are allowed)'],
  [/@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//i, 'a remote @import'],
];
/** Strings that only exist in development builds (src/background/devReload.ts). */
const DEV_ONLY_MARKERS = ['dce.dev.', 'localhost:5858'];

function checkBuiltCode(distDir, dev, problems, notes) {
  const problemsBefore = problems.length;
  let scanned = 0;
  for (const file of listFiles(distDir)) {
    const isJs = /\.(?:m?js)$/i.test(file);
    if (!isJs && !/\.css$/i.test(file)) continue;
    scanned++;
    const code = readFileSync(file, 'utf8');
    const label = posix(relative(distDir, file));
    for (const [pattern, what] of isJs ? FORBIDDEN_CODE : FORBIDDEN_CSS) {
      if (pattern.test(code)) problems.push(`${label}: uses ${what}`);
    }
    if (isJs && !dev) {
      for (const marker of DEV_ONLY_MARKERS) if (code.includes(marker)) problems.push(`${label}: contains "${marker}" - development-only code in a production build`);
    }
  }
  if (problems.length === problemsBefore) notes.push(`${scanned} built script/style file(s) need nothing the extension CSP forbids${dev ? '' : ', no development-only code'}`);
}

/**
 * The static `import ... from "x"` / `import "x"` specifiers at the very top of a bundled ES module, which is where bundlers
 * put them. Exact (the scan stops at the first non-import statement), unlike a regex over the whole file, which also matches
 * strings such as the `import X from './X'` hints inside React's development warnings.
 */
export function leadingImports(code) {
  const specifiers = [];
  const skippable = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/; // whitespace and comments
  const statement = /^import\s*(?:[\w$*\s{},]*?\s*from\s*)?(["'`])([^"'`]+)\1\s*;?/;
  let rest = code;
  for (;;) {
    rest = rest.replace(skippable, '');
    const match = statement.exec(rest);
    if (!match) return specifiers;
    specifiers.push(match[2]);
    rest = rest.slice(match[0].length);
  }
}

/** Literal dynamic imports, `import("x")`, anywhere in the code (regex based: use on minified production code). */
export function dynamicImports(code) {
  return [...code.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)].map((m) => m[2]);
}

/** Static + literal-dynamic import specifiers of a JS module, and whether it has an `import(expression)` it cannot resolve. */
export function importSpecifiers(code) {
  return {
    specifiers: [...new Set([...leadingImports(code), ...dynamicImports(code)])],
    hasDynamicNonLiteral: /\bimport\s*\(\s*(?!["'`])/.test(code),
  };
}

/** Every relative import of the page chunks in assets/ must exist (a missing shared chunk breaks the page at load time). */
function checkChunkGraph(distDir, dev, problems, notes) {
  const assets = join(distDir, 'assets');
  if (!existsSync(assets)) return;
  let checked = 0;
  for (const file of listFiles(assets).filter((f) => /\.m?js$/i.test(f))) {
    const label = posix(relative(distDir, file));
    const code = readFileSync(file, 'utf8');
    // Development bundles contain readable library warnings that look like dynamic imports: only trust the static ones there.
    const specifiers = dev ? leadingImports(code) : importSpecifiers(code).specifiers;
    for (const specifier of specifiers) {
      if (!/^\.\.?\//.test(specifier)) {
        problems.push(`${label}: imports "${specifier}" - only relative imports of other chunks are allowed`);
        continue;
      }
      const target = resolveInDist(distDir, dirname(file), specifier);
      if (target === null || !isFile(target)) problems.push(`${label}: imports "${specifier}" which does not exist in dist/`);
      checked++;
    }
  }
  notes.push(`assets/: ${checked} chunk import(s) resolve`);
}

function checkBackground(distDir, manifest, problems, notes) {
  const worker = manifest.background?.service_worker;
  if (worker !== 'background.js') problems.push(`background.service_worker must be "background.js" (un-hashed), found ${JSON.stringify(worker)}`);
  if (manifest.background?.type !== 'module') problems.push('background.type must be "module"');
  const entry = join(distDir, 'background.js');
  if (!isFile(entry)) {
    problems.push('background.js is missing');
    return;
  }
  const code = readFileSync(entry, 'utf8');
  const { specifiers, hasDynamicNonLiteral } = importSpecifiers(code);
  if (specifiers.length > 0) problems.push(`background.js imports ${specifiers.map((s) => `"${s}"`).join(', ')} - it must be one self-contained file`);
  if (hasDynamicNonLiteral) problems.push('background.js: dynamic import() with a non-literal specifier');
  if (specifiers.length === 0 && !hasDynamicNonLiteral) notes.push(`background.js is a single self-contained module (no imports, ${code.length} bytes)`);
}

function checkContentScript(distDir, manifest, problems, notes) {
  const scripts = manifest.content_scripts ?? [];
  if (scripts.length !== 1) problems.push(`expected exactly one content_scripts entry, found ${scripts.length}`);
  const [script] = scripts;
  if (script) {
    if (JSON.stringify(script.js) !== '["content.js"]') problems.push(`content_scripts[0].js must be ["content.js"], found ${JSON.stringify(script.js)}`);
    if (script.css?.length > 0) problems.push('content_scripts[0].css must be empty: the content script ships its CSS inside content.js (import "?inline")');
    if (script.run_at !== 'document_idle') problems.push(`content_scripts[0].run_at must be "document_idle", found ${JSON.stringify(script.run_at)}`);
    if (script.all_frames) problems.push('content_scripts[0].all_frames must be false (top frame only)');
    if (script.world && script.world !== 'ISOLATED') problems.push(`content_scripts[0].world must be ISOLATED, found ${script.world}`);
  }
  const entry = join(distDir, 'content.js');
  if (!isFile(entry)) {
    problems.push('content.js is missing');
    return;
  }
  const code = readFileSync(entry, 'utf8');
  try {
    // A classic script cannot contain import/export declarations (or import.meta / top-level await): exactly what Chrome needs.
    new vm.Script(code, { filename: 'content.js' });
  } catch (error) {
    problems.push(`content.js is not a classic script (import/export statements?): ${error.message}`);
  }
  if (/\bimport\s*\(/.test(code)) problems.push('content.js contains a dynamic import() - it must be one self-contained file');
  if (code.trim() === '') {
    notes.push('content.js is empty (placeholder content script)');
  } else if (!/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*[(!]/.test(code)) {
    problems.push(
      'content.js does not start with an IIFE wrapper "(function(){...})()": top-level variables would leak into the isolated world ' +
        '(an entry that exports becomes "var dceContent = (function(exports){...})({})": do not export from src/content/index.ts)',
    );
  } else {
    notes.push(`content.js is a single classic-script IIFE (${code.length} bytes)`);
  }
}

// ---- layout ---------------------------------------------------------------------------------

function checkLayout(distDir, dev, problems, notes) {
  const unexpected = readdirSync(distDir).filter((name) => !ROOT_ENTRIES.includes(name));
  for (const name of unexpected) {
    problems.push(
      REMOVED_PAGES.includes(name)
        ? `${name} must not exist: the in-page settings modal was removed (docs/PLAN.md §2, §9)`
        : `unexpected entry at the top of dist/: ${name}`,
    );
  }
  if (unexpected.length === 0) notes.push(`dist/ top level is exactly: ${ROOT_ENTRIES.join(', ')}`);
  if (!dev) {
    const maps = listFiles(distDir).filter((f) => /\.map$/i.test(f));
    for (const map of maps) problems.push(`${posix(relative(distDir, map))}: source map in a production build`);
  }
  if (existsSync(join(distDir, 'assets'))) {
    const stray = readdirSync(join(distDir, 'assets')).filter((name) => /\.html$/i.test(name));
    for (const name of stray) problems.push(`assets/${name}: HTML pages belong at the dist root`);
  }
}

/** @returns {{ problems: string[], notes: string[] }} */
export function verifyDist({ distDir = join(ROOT, 'dist'), rootDir = ROOT } = {}) {
  const problems = [];
  const notes = [];
  if (!existsSync(distDir)) return { problems: [`${distDir} does not exist - run "npm run build" first`], notes };
  const manifest = readJson(join(distDir, 'manifest.json'), problems, 'manifest.json');
  const pkg = readJson(join(rootDir, 'package.json'), problems, 'package.json');
  if (!manifest) return { problems, notes };

  const dev = isDevManifest(manifest);
  notes.push(dev ? 'DEVELOPMENT build (dev-server permission present; not for packing)' : 'production build');
  checkManifest(manifest, pkg, dev, problems, notes);

  const refs = manifestReferences(manifest);
  let missing = 0;
  for (const { label, path } of refs) {
    if (!isFile(join(distDir, path))) {
      problems.push(`manifest ${label} -> ${path} does not exist in dist/`);
      missing++;
    }
  }
  if (missing === 0) notes.push(`all ${refs.length} files referenced by manifest.json exist`);

  checkIcons(distDir, manifest, problems);
  checkLocales(distDir, manifest, problems, notes);
  checkLayout(distDir, dev, problems, notes);
  for (const page of PAGES) checkPage(distDir, page, problems, notes);
  checkBackground(distDir, manifest, problems, notes);
  checkContentScript(distDir, manifest, problems, notes);
  checkChunkGraph(distDir, dev, problems, notes);
  checkBuiltCode(distDir, dev, problems, notes);
  return { problems, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const distDir = resolve(process.argv[2] ?? join(ROOT, 'dist'));
  const { problems, notes } = verifyDist({ distDir });
  for (const note of notes) console.log(`ok   ${note}`);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) found in ${distDir}`);
    process.exit(1);
  }
  console.log(`\n${distDir} verified`);
}
