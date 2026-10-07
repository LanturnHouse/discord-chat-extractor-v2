/**
 * The consent gate (docs/PLAN.md 6차 변경): until the user has agreed on the first-run screen (`settings.consentAt`) the worker
 * reads nothing from Discord and asks it nothing - no authorization header, no account lookup, no list of a server's channels.
 * The answer lives in memory (the first read of storage, then `chrome.storage.onChanged`), so the webRequest listener, which
 * runs for every request of the Discord page, never has to read storage again.
 *
 * Agreeing needs no extra step: the next request the Discord page sends carries the authorization again and is captured then.
 * When the consent is withdrawn (`consentAt` back to null, or the settings are gone) the captured authorization and the account
 * are removed at once.
 */
import { LOCAL, SESSION } from '@/shared';
import { readSettings, writeAccount } from './store';
import { normalizeSettings } from './validate';

/** null = not read yet. */
let granted: boolean | null = null;
let loading: Promise<boolean> | null = null;

/** The answer if it is known already (no storage access), else null. */
export function peekConsent(): boolean | null {
  return granted;
}

/** Has the user agreed? Reads the settings once per worker lifetime; every later call answers from memory. Never rejects. */
export function hasConsent(): Promise<boolean> {
  if (granted !== null) return Promise.resolve(granted);
  loading ??= readSettings()
    .then((settings) => {
      granted ??= settings.consentAt !== null; // a change that arrived while reading wins
      return granted;
    })
    .catch(() => false) // storage unavailable: nothing is read until it works (and the next call asks again)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Removes what was captured with the consent: the authorization and the account that belongs to it. */
export async function forgetCredentials(): Promise<void> {
  await chrome.storage.session.remove([SESSION.token, SESSION.tokenCapturedAt]);
  await writeAccount(null, null);
}

/** `chrome.storage.onChanged`: keeps the answer current, and forgets the credentials when the consent goes away. */
export function onConsentStorageChanged(changes: Record<string, { newValue?: unknown }>, areaName: string): void {
  if (areaName !== 'local') return;
  const change = changes[LOCAL.settings];
  if (change === undefined) return;
  const now = normalizeSettings(change.newValue).consentAt !== null;
  const before = granted;
  granted = now;
  if (!now && before !== false) void forgetCredentials().catch(() => undefined);
}

/** Forgets the cached answer (tests; a worker restart does the same). */
export function resetConsentState(): void {
  granted = null;
  loading = null;
}
