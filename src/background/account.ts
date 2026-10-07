/**
 * The current account (docs/PLAN.md §3, §7.2): whenever the captured authorization changes, the worker asks Discord whose it
 * is (`GET /api/v9/users/@me`, a direct allow-listed fetch) and stores the answer as `SESSION.account` (and `LOCAL.lastAccount`,
 * which the content script reads to find its queue). A 401 means the value is dead: it is removed with compare-and-clear and
 * the account is null. Any other failure leaves things as they are; the next token change, popup opening (`status/get`) or
 * worker start tries again.
 *
 * While the verdict for a NEW value is pending the account is null, never the previous user's: a queue action must not be
 * filed under one account while a job would run with another one's authorization.
 */
import type { AccountInfo } from '@/shared';
import { hasConsent } from './consent';
import { apiGet } from './discordApi';
import { readAccount, readToken, writeAccount } from './store';
import { clearTokenIfEqual } from './token';
import { isNumericId, isRecord } from './util';

const VERIFIED_TTL_MS = 10 * 60 * 1000;
/** A value that got a 401 is not asked about again for this long (a page still sending a dead value must not make us hammer Discord). */
const REJECTED_TTL_MS = 60 * 1000;
/** `ensureAccount` (popup opening, worker start) retries a missing account at most this often. */
const ENSURE_MIN_INTERVAL_MS = 10 * 1000;
const MAX_NAME_LENGTH = 100;
const MAX_CACHED_TOKENS = 4;

/** Verdicts by authorization value, in memory only (a worker restart simply asks again). */
const verified = new Map<string, { account: AccountInfo; at: number }>();
let rejected: { token: string; at: number } | null = null;
let lastAttemptAt = 0;
let running: Promise<void> | null = null;
let again = false;

/** Default avatar of a user without one: the same CDN image Discord's own client falls back to. */
export function defaultAvatarUrl(id: string): string {
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
}

export function avatarUrl(id: string, hash: string | null): string {
  return hash === null ? defaultAvatarUrl(id) : `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=128`;
}

/** The fields of a `users/@me` answer the extension uses, or null when the answer is not a user. */
export function parseAccountInfo(data: unknown): AccountInfo | null {
  if (!isRecord(data)) return null;
  const { id, username, global_name: globalName, avatar } = data;
  if (!isNumericId(id) || typeof username !== 'string' || username === '') return null;
  const hash = typeof avatar === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(avatar) ? avatar : null;
  return {
    id,
    username: username.slice(0, MAX_NAME_LENGTH),
    globalName: typeof globalName === 'string' && globalName !== '' ? globalName.slice(0, MAX_NAME_LENGTH) : null,
    avatarUrl: avatarUrl(id, hash),
  };
}

/**
 * Discord answered 401 to `token`: remember that, forget its verdict and remove it from the session store, but only if it is
 * STILL the stored value (compare-and-clear: a newer capture must survive a 401 for an older one). The account goes with it.
 * @returns true when the value was removed
 */
export async function revokeToken(token: string): Promise<boolean> {
  rejected = { token, at: Date.now() };
  verified.delete(token);
  const removed = await clearTokenIfEqual(chrome.storage.session, token);
  if (removed) await writeAccount(null, null); // unless a newer capture has already arrived
  return removed;
}

/** Stores the verdict only if the authorization is still the one that was asked about (it may have changed meanwhile). */
async function applyIfCurrent(token: string, account: AccountInfo): Promise<void> {
  await writeAccount(account, token);
}

async function verifyOnce(): Promise<void> {
  lastAttemptAt = Date.now();
  if (!(await hasConsent())) return; // nothing is asked of Discord before the user has agreed
  const token = await readToken();
  if (token === null) {
    await writeAccount(null, null);
    return;
  }

  const cached = verified.get(token);
  if (cached && Date.now() - cached.at < VERIFIED_TTL_MS) {
    await applyIfCurrent(token, cached.account);
    return;
  }
  if (rejected !== null && rejected.token === token && Date.now() - rejected.at < REJECTED_TTL_MS) return;

  const result = await apiGet('/api/v9/users/@me', token);
  if (result.ok) {
    const account = parseAccountInfo(result.data);
    if (account === null) return;
    if (verified.size >= MAX_CACHED_TOKENS) verified.delete(verified.keys().next().value as string);
    verified.set(token, { account, at: Date.now() });
    await applyIfCurrent(token, account);
    return;
  }
  if (result.kind === 'unauthorized') await revokeToken(token);
  // Network errors, 429, 5xx: keep the state; something else retries (ensureAccount).
}

/**
 * Checks the stored authorization against Discord and updates the account. Calls overlap safely: while one runs, further
 * calls make it run once more afterwards (so the last token change always gets its verdict). Never rejects.
 */
export function verifyAccount(): Promise<void> {
  if (running !== null) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        try {
          await verifyOnce();
        } catch {
          // storage hiccup: the next trigger retries
        }
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** The verdict for `token` if it was verified recently (no request needed), else null. */
function knownAccount(token: string): AccountInfo | null {
  const cached = verified.get(token);
  return cached && Date.now() - cached.at < VERIFIED_TTL_MS ? cached.account : null;
}

/**
 * `chrome.storage.onChanged` saw `SESSION.token` change. The old account no longer matches: a value Discord already vouched
 * for recently switches to its account at once (two Discord clients can make the captured value alternate; that must not cost
 * a request or a blank account every time), any other value clears the account until it is verified. A removed value
 * (`undefined`) leaves the account null.
 */
export function onTokenChanged(newValue: unknown): void {
  void (async () => {
    const token = typeof newValue === 'string' && newValue !== '' ? newValue : null;
    const account = token === null ? null : knownAccount(token);
    await writeAccount(account, token); // skipped when the value has changed again already: that change has its own handler
    if (token !== null && account === null) await verifyAccount();
  })().catch(() => undefined);
}

/**
 * Self-healing: an authorization is stored but no account was verified (the first attempt failed, the worker restarted
 * mid-check). Called when the popup asks for the status and when the worker starts; throttled, never rejects.
 */
export function ensureAccount(): void {
  void (async () => {
    if (running !== null || Date.now() - lastAttemptAt < ENSURE_MIN_INTERVAL_MS) return;
    const [token, account] = await Promise.all([readToken(), readAccount()]);
    if (token === null || account !== null) return;
    await verifyAccount();
  })().catch(() => undefined);
}

/** Forgets every in-memory verdict (tests; a worker restart does the same). */
export function resetAccountState(): void {
  verified.clear();
  rejected = null;
  lastAttemptAt = 0;
  running = null;
  again = false;
}
