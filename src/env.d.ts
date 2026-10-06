// Ambient declarations shared by every entry point. `?raw` / `?inline` imports (CSS as a string) are typed by `vite/client`
// (see tsconfig `types`); only the build-time constants below are ours.

/**
 * `true` in `vite build --mode development` (and `npm run dev`), `false` in every other build and under Vitest.
 * Vite replaces it statically (see `define` in vite.config.ts), so `if (__DEV__) { ... }` blocks, and the modules only
 * they use (e.g. background/devReload.ts), are removed from the production bundle.
 */
declare const __DEV__: boolean;
