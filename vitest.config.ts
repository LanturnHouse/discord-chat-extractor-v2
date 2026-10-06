import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': r('./src') } },
  // Same constant vite.config.ts defines; tests exercise the production code paths (dev-only code takes its dependencies
  // as arguments, see src/background/devReload.ts, or stubs the global with vi.stubGlobal('__DEV__', true)).
  define: { __DEV__: JSON.stringify(false) },
  test: {
    environment: 'node',
    // Files that need a DOM opt in with `// @vitest-environment jsdom` at the top.
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    globals: false,
    // jsdom component tests render a lot; files run in parallel workers, so 5 s is too tight under load.
    testTimeout: 20_000,
    // Vitest replaces every .css import with '' unless told otherwise. `?raw` (the HTML export reads stylesheets that way)
    // and `?inline` (the content script ships its CSS as a string) must give the real file text.
    css: { include: [/\.css\?(?:raw|inline)$/] },
  },
});
