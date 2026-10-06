// Content script entry (injected into discord.com at document_idle, bundled as one IIFE file: content.js). docs/PLAN.md §3,
// §4, §7.1, §7.4: row buttons and the server button with tooltip and toast, the shortcut, theme capture and injection health
// reports. It makes no API calls: it only sends `queue/toggle`, `queue/addCategory`, `queue/addGuild`, `queue/groupInfo` and
// `inject/health` to the background worker.
//
// Rules for this bundle: no code splitting and no remote code; the CSS is imported as text (`./styles.css?inline`, see
// ui/overlay.ts) so it ships inside content.js. Do not `export` anything from this entry: an IIFE with exports assigns a
// global (`dceContent`) in the isolated world. The logic lives in app.ts, which can be tested without this side effect.
import { createApp } from './app';

// Development builds only: proves in the Discord tab's console that the dev loop reloaded the tab with the new build.
// (The wording is kept verbatim: tests/config/build.test.ts looks for it in the development bundle.)
if (__DEV__) {
  console.debug('[dce] content script (placeholder) loaded');
}

const app = createApp();

// Development builds only: the running app, reachable from the DevTools console after switching its context to this
// extension (the dropdown above the console). Production bundles contain none of this.
if (__DEV__) {
  (globalThis as { __dce?: unknown }).__dce = app;
}

void app.start();
