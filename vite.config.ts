import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build, defineConfig, type Plugin } from 'vite';
import { buildManifest, type BuildMode } from './src/manifest.ts';

// dist/ layout (loadable via chrome://extensions -> "Load unpacked"), see docs/PLAN.md §9:
//   popup.html  offscreen.html   the two extension pages at the root + assets/* (hashed, shared chunks)
//   background.js   the service worker: ONE un-hashed ES module, no imports
//   content.js      the content script: ONE un-hashed IIFE, no imports, its CSS inlined as text (`?inline`)
//   manifest.json   generated from src/manifest.ts
//   icons/ _locales/   copied as-is from public/
//
// Notes for the next person (Vite 8 = Rolldown):
// - This file is loaded by Vite's config loader and must stay compatible with Node's native TS loading ("configLoader:
//   native" is planned to become the default): explicit `.ts` extensions and `with { type: 'json' }` in the import chain
//   (vite.config.ts -> src/manifest.ts -> src/shared/defaults.ts). Relative imports only, no `@` alias there.
// - Rolldown ignores assignments to `bundle[...]` in `generateBundle` (use `this.emitFile` and `delete`).

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const alias = { '@': r('./src') };

/** Build-time constants, identical for the page build and the two single-file builds. */
function defines(dev: boolean) {
  return {
    __DEV__: JSON.stringify(dev),
    // Library-mode builds (below) leave process.env.NODE_ENV alone for the consumer to replace, and nobody consumes them.
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  };
}

/**
 * The two extension pages (docs/PLAN.md §9; there is no settings modal page any more). Vite emits an HTML entry under its path
 * relative to the root (`src/popup/popup.html`); see `flatHtml`.
 */
const PAGES = {
  popup: r('./src/popup/popup.html'),
  offscreen: r('./src/offscreen/offscreen.html'),
};

interface SingleFileEntry {
  entry: string;
  fileName: string;
  format: 'es' | 'iife';
  /** Global name, required by Vite for `iife`. The content script has no exports, so nothing is ever assigned to it. */
  name?: string;
}

const SINGLE_FILE_ENTRIES: readonly SingleFileEntry[] = [
  { entry: r('./src/background/index.ts'), fileName: 'background.js', format: 'es' },
  { entry: r('./src/content/index.ts'), fileName: 'content.js', format: 'iife', name: 'dceContent' },
];

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * The service worker and the content script are built in their own passes instead of as extra entries of the page build:
 * with several entries, every module they share (src/shared/*, src/lib/*) is hoisted into a hashed `assets/*.js` chunk that
 * `background.js` / `content.js` would then have to import - impossible for a classic content script and fragile for the
 * worker. Each of the two gets a nested `build()` (the technique of v1's vite.config.ts) in library mode with code splitting
 * off. The result is emitted into the page build's bundle, so every file of dist/ is written together.
 *
 * A nested build that produces anything but the one JS file (a CSS file from a plain `import './x.css'`, a split chunk)
 * fails the build with a message that says what to do.
 */
function singleFileEntries(mode: BuildMode): Plugin {
  const dev = mode === 'development';
  return {
    name: 'dce:single-file-entries',
    apply: 'build',
    buildStart() {
      // `vite build --watch` only watches the page build's own module graph: also watch the worker, the content script,
      // everything they import, the manifest inputs and public/, or edits to them would never trigger a rebuild.
      for (const file of [...listFiles(r('./src')), ...listFiles(r('./public')), r('./package.json')]) this.addWatchFile(file);
    },
    async generateBundle() {
      for (const spec of SINGLE_FILE_ENTRIES) {
        const result = await build({
          configFile: false,
          mode,
          logLevel: 'warn',
          resolve: { alias },
          define: defines(dev),
          build: {
            write: false,
            emptyOutDir: false,
            copyPublicDir: false,
            target: 'es2022',
            minify: !dev,
            sourcemap: dev ? 'inline' : false,
            assetsInlineLimit: Number.MAX_SAFE_INTEGER, // one file: images/fonts referenced by the code or its CSS become data: URIs
            lib: { entry: spec.entry, formats: [spec.format], name: spec.name, fileName: () => spec.fileName },
            rolldownOptions: { output: { codeSplitting: false } },
          },
        });
        const outputs = (Array.isArray(result) ? result : 'output' in result ? [result] : []).flatMap((out) => out.output);
        const chunk = outputs[0];
        if (outputs.length !== 1 || chunk?.type !== 'chunk') {
          const produced = outputs.map((file) => file.fileName).join(', ');
          this.error(
            `${spec.fileName} must be one self-contained file, but its build produced: ${produced}. ` +
              `Import CSS as text (\`import css from './x.css?inline'\`; a plain \`import './x.css'\` emits a CSS file) ` +
              `and do not rely on code splitting.`,
          );
        }
        this.emitFile({ type: 'asset', fileName: spec.fileName, source: chunk.code });
      }
    },
  };
}

/**
 * Moves `src/popup/popup.html` -> `popup.html`. The pages reference their assets by absolute `/assets/...` URLs, so they
 * work at the root. (Rolldown ignores assignments to `bundle[...]`: the page is re-emitted under its flat name instead.)
 */
function flatHtml(): Plugin {
  return {
    name: 'dce:flat-html',
    apply: 'build',
    enforce: 'post', // after vite:build-html has emitted the pages
    generateBundle(_options, bundle) {
      const seen = new Set<string>();
      for (const [key, file] of Object.entries(bundle)) {
        if (file.type !== 'asset' || !key.endsWith('.html')) continue;
        const flat = basename(key);
        if (seen.has(flat)) this.error(`Two HTML pages are both called ${flat}`);
        seen.add(flat);
        if (flat === key) continue;
        this.emitFile({ type: 'asset', fileName: flat, source: file.source });
        delete bundle[key];
      }
    },
  };
}

/** dist/manifest.json, generated from src/manifest.ts. */
function manifestJson(mode: BuildMode): Plugin {
  return {
    name: 'dce:manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(buildManifest(mode), null, 2)}\n` });
    },
  };
}

/**
 * A watch rebuild must not empty dist/ first (Vite's default): Chrome may be reloading the unpacked extension from it at
 * that very moment and would find no manifest. `npm run dev` (scripts/dev.mjs) cleans dist/ once, before the first build.
 */
function keepDistWhileWatching(): Plugin {
  return {
    name: 'dce:keep-dist-while-watching',
    apply: 'build',
    config(config) {
      if (config.build?.watch) return { build: { emptyOutDir: false } };
    },
  };
}

export default defineConfig(({ mode }) => {
  const buildMode: BuildMode = mode === 'development' ? 'development' : 'production';
  const dev = buildMode === 'development';
  return {
    plugins: [react(), keepDistWhileWatching(), flatHtml(), manifestJson(buildMode), singleFileEntries(buildMode)],
    resolve: { alias },
    define: defines(dev),
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      minify: !dev,
      sourcemap: dev ? 'inline' : false,
      modulePreload: { polyfill: false },
      rolldownOptions: { input: PAGES },
    },
  };
});
