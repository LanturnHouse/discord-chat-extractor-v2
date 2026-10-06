// Dev server for inspecting the popup in a normal browser tab, on the in-memory mock (no extension, no Discord, no network).
//
//   npx vite --config src/ui/preview/vite.config.ts
//
// opens http://localhost:5859/popup.html?mock=1 . `&scenario=running|tree|idle|empty|consent|no-discord|checking|unhealthy` picks the
// starting data; the panel next to the popup switches scenario, theme and language and lists the messages the popup sends.
// This config is separate from the root vite.config.ts on purpose: nothing of the extension build depends on it.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // popup.html lives in src/popup; the shared code (src/ui, src/shared) is outside that root, so the whole repo may be served.
  root: r('../../popup'),
  plugins: [react()],
  resolve: { alias: { '@': r('../../') } },
  define: { __DEV__: JSON.stringify(true) },
  server: { port: 5859, open: '/popup.html?mock=1', fs: { allow: [r('../../../')] } },
});
