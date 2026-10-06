/**
 * Development builds only (the build-time dev flag, see src/env.d.ts; the production bundle has no logging at all): `[dce]`
 * lines in the Discord tab's console for the dev loop and for QA on the live page. Never log message content, tokens or the
 * account: row counts, row kinds and health reasons are all that goes through here.
 */
export function debug(...args: unknown[]): void {
  if (__DEV__) console.debug('[dce]', ...args);
}
