# Discord Chat Extractor V2

Chrome MV3 extension: adds a download button to channel and DM rows of the Discord web client. One click puts the chat into a
per-account download list with the common settings (click again = removed); the toolbar popup manages the list, the common
settings and optional per-chat settings (the item's ⚙), and downloads everything as HTML (default), TXT, Markdown, Excel, CSV
or JSON (optionally one ZIP). There is no settings modal on Discord pages. **`docs/PLAN.md` (Korean) is the single source of
truth: read it before changing anything.** The v1 project (separate repository `LanturnHouse/discord-chat-extractor`) was the reference for the lib port.

## Commands
- `npm run dev`: watching development build + dev server on :5858 (it exits by itself when its parent process is gone). The dev
  service worker reloads the extension and the open Discord tabs once a rebuild has settled: the server answers 503 until
  `dist/` is complete and quiet for 1.5 s, the worker needs the new build id twice, 2.5 s apart, and two reloads are at least
  20 s apart (a burst of rebuilds, e.g. after a git merge, becomes one reload). Load `dist/` unpacked once in chrome://extensions.
- `npm run build`: typecheck + production build into `dist/`. `npm run build:dev`: one-off development build.
- `npm run typecheck`, `npm test` (`npm run test:watch`), `npm run verify` (sanity-checks `dist/`), `npm run icons`,
  `npm run pack` (verify + zip a PRODUCTION `dist/`; refuses development builds).
- A step is done only when `typecheck`, `test`, `build` and `verify` all pass. In a fresh git worktree run `npm ci` first.

## Directory ownership (docs/PLAN.md §11)
| Path | Owner |
|---|---|
| `src/lib`, `tests/lib` | P1b: v1 core port (API client, filters, writers, filenames) |
| `src/background`, `src/offscreen`, `tests/background`, `tests/offscreen` | A1/A2: service worker, offscreen download engine |
| `src/content`, `tests/content` | B: content script (row buttons, toasts, theme, shortcut; no API calls) |
| `src/ui`, `src/popup`, `tests/ui`, `tests/popup` | C: popup, shared React UI (common settings panel, item editor), i18n |
| `src/shared`, `src/manifest.ts`, `package.json`, `package-lock.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `scripts/`, `public/`, `docs/`, `tests/shared`, `tests/scripts`, `tests/config`, `tests/manifest.test.ts` | main agent only |

Work only in your own directories (each agent has its own git worktree). Need a change anywhere else? Put it in your report.

## Rules
- Contracts in `src/shared` (types, storage keys, messages: PLAN §5.1-§5.3) belong to the main agent: **propose changes in
  your report, never edit them.** `tests/shared/contractSync.test.ts` fails when they drift from the plan. The defaults and
  `resolveItemSettings` (§5.4, `src/shared/defaults.ts`) are pinned by `tests/shared/defaults.test.ts`.
- A queue item's effective settings = `resolveItemSettings(item, settings.common)` (`item.settings ?? common`, a deep copy),
  fixed when a job starts. `settings: null` means "follows the common settings".
- Live Discord testing only in the server and DM the maintainer designates for that session. Never open any other server or
  DM. Never read, print, log or store the auth token (not in code, tests or fixtures); fixtures use neutral names.
- No new runtime dependencies, and no edits to `package.json`, without the main agent's approval.
- No remote code, analytics or external requests; every library is bundled locally. Every request path must pass the
  allow-lists in `src/shared/allowlist.ts` (engine transport list; the background's own GETs use the narrower
  `API_GET_ALLOWLIST`; the content script and the popup make no API calls).
- The main agent (Opus) orchestrates and reviews; Sonnet subagents do the coding, searching and docs.

## Build facts worth knowing
- `dist/`: `popup.html` and `offscreen.html` at the root (+ hashed `assets/`), `background.js` (one ES module, no imports),
  `content.js` (one IIFE, no imports), `manifest.json` (generated from `src/manifest.ts`), `icons/`, `_locales/`. There is no
  `modal.html` and no `web_accessible_resources`: `npm run verify` fails if either appears.
- `content.js` ships its CSS as a string: `import css from './styles.css?inline'`. A plain `import './x.css'` (or anything that
  needs a second output file) fails the build with an explanation; the same goes for `background.js`.
- A new extension page = `src/<name>/<name>.html` + an entry in `PAGES` in `vite.config.ts` (main agent); it lands at the dist root.
- `__DEV__` is true only in development builds (stub it in tests with `vi.stubGlobal('__DEV__', true)`). Dev-only code goes behind
  `if (__DEV__)` so production bundles do not contain it. While the dev server runs the dev worker never goes to sleep: test
  suspend/resume with a production build.
- Tests live in `tests/` mirroring `src/` as `*.test.ts(x)`; `@/` means `src/`. They run in node; a DOM test starts with the
  `@vitest-environment jsdom` docblock comment. `?raw` and `?inline` CSS imports return the file text.
- Vite 8 loads `vite.config.ts` natively-compatible: keep explicit `.ts` extensions and `with { type: 'json' }` in its import chain.
