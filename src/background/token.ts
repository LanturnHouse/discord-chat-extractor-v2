import { SESSION } from '@/shared';

// Ported from v1 (src/background/token.ts); the storage keys come from the V2 contract (`SESSION.token`,
// `SESSION.tokenCapturedAt`). Added in V2: `clearTokenIfEqual` at the bottom, and the consent gate (`TokenCaptureDeps.consent`:
// before the user has agreed nothing is looked at, 6th change).

/** webRequest filter: the REST API of every Discord web client flavour (stable, ptb, canary). */
export const DISCORD_API_URL_PATTERNS = [
  'https://discord.com/api/*',
  'https://ptb.discord.com/api/*',
  'https://canary.discord.com/api/*',
];

const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 300;
/** Exact hosts of the web client. Other subdomains (support., status., ...) never carry the user's API token. */
const DISCORD_WEB_HOSTS = new Set(['discord.com', 'ptb.discord.com', 'canary.discord.com']);

/** The slice of `chrome.webRequest.OnBeforeSendHeadersDetails` that capturing needs. */
export interface RequestDetails {
  /** Origin of the document that issued the request, e.g. `https://discord.com`. */
  initiator?: string;
  tabId: number;
  requestHeaders?: ReadonlyArray<{ name: string; value?: string }>;
}

/** The slice of `chrome.storage.session` that capturing needs. */
export interface SessionStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The consent gate (consent.ts). */
export interface ConsentGate {
  /** The answer if it is known without reading storage, else null. */
  peek(): boolean | null;
  has(): Promise<boolean>;
}

export interface TokenCaptureDeps {
  storage: SessionStorageLike;
  now: () => number;
  /** Nothing is looked at, let alone stored, until this says yes. */
  consent: ConsentGate;
}

export interface TokenCapture {
  /** Resolves once everything accepted so far has been persisted (or failed). Never rejects. */
  handle(details: RequestDetails): Promise<void>;
  /** Feed `chrome.storage.onChanged` so a token removed behind our back is captured again. */
  onStorageChanged(changes: Record<string, { newValue?: unknown }>, areaName: string): void;
}

/** True only for the web client origins: discord.com, ptb. and canary. */
function isDiscordOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '') return false;
  return DISCORD_WEB_HOSTS.has(url.hostname);
}

/**
 * Sanity filter, not authentication: rejects values that are clearly not a raw user token
 * (empty, absurd length, binary, multi-word). Scheme-prefixed credentials such as `Bearer <x>` / `Bot <x>` contain a
 * space and are therefore rejected by the printable-ASCII-without-whitespace rule.
 */
export function isPlausibleToken(value: string): boolean {
  if (value.length < MIN_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH) return false;
  return /^[\x21-\x7e]+$/.test(value);
}

/** Returns the Authorization value if (and only if) a Discord web page sent it. */
export function extractToken(details: RequestDetails): string | null {
  // Anything not initiated by a Discord page is ignored: our own app (chrome-extension://<id>), other extensions,
  // third-party sites and background requests without a page (tabId -1) all fail this one check.
  if (!isDiscordOrigin(details.initiator)) return null;
  const header = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'authorization');
  const value = header?.value;
  if (typeof value !== 'string') return null;
  return isPlausibleToken(value) ? value : null;
}

/**
 * Discord sends hundreds of API requests per minute, all with the same token, and the MV3 worker can be killed at any
 * time. So: the dedupe filter lives in memory (cheap synchronous fast path) while the source of truth is
 * `storage.session`, which is consulted before every write - a freshly restarted worker therefore never rewrites an
 * unchanged token. Nothing here may log: the token is a credential.
 */
export function createTokenCapture({ storage, now, consent }: TokenCaptureDeps): TokenCapture {
  /** Last token seen (and therefore queued/persisted by us). */
  let known: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function persist(token: string): Promise<void> {
    const stored = (await storage.get(SESSION.token))[SESSION.token];
    if (stored === token) return;
    await storage.set({ [SESSION.token]: token, [SESSION.tokenCapturedAt]: now() });
  }

  return {
    handle(details) {
      if (consent.peek() === false) return queue; // not agreed yet: the request's headers are not even looked at
      // Serialised so an older token can never overwrite a newer one. The header is read only once the consent is known.
      queue = queue
        .then(async () => {
          if (!(await consent.has())) return;
          const token = extractToken(details);
          if (token === null || token === known) return;
          known = token;
          try {
            await persist(token);
          } catch {
            // Storage failures are not actionable here (and error objects must not be logged near credentials).
            // Forgetting the token makes the next request retry the write.
            if (known === token) known = null;
          }
        })
        .catch(() => undefined);
      return queue;
    },

    onStorageChanged(changes, areaName) {
      if (areaName !== 'session') return;
      const change = changes[SESSION.token];
      if (change && change.newValue === undefined) known = null;
    },
  };
}

// ---- added in V2 -----------------------------------------------------------------------------------------------------

/** The slice of `chrome.storage.session` that compare-and-clear needs. */
export interface TokenStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  remove(keys: string[]): Promise<void>;
}

/**
 * Compare-and-clear: removes the stored authorization (and its capture time) only when it still equals `expected`, so a 401
 * for an OLD value can never wipe a NEWER capture. `chrome.storage` has no atomic compare-and-delete, so this is a
 * read-then-remove with a window of a few milliseconds (the same trade-off v1 made): a wrongly removed fresh token is
 * captured again by the next request of the Discord page.
 *
 * Callers pass the value they used (the one the engine got, the one a request was sent with), never "whatever is stored now".
 * @returns true when the stored value matched and was removed.
 */
export async function clearTokenIfEqual(storage: TokenStorageLike, expected: string): Promise<boolean> {
  if (expected === '') return false;
  const stored = (await storage.get(SESSION.token))[SESSION.token];
  if (stored !== expected) return false;
  await storage.remove([SESSION.token, SESSION.tokenCapturedAt]);
  return true;
}
