/**
 * Injection health (docs/PLAN.md §3, §7.2): the content script reports whether its row buttons could be placed
 * (`inject/health`); the worker keeps the newest report of every Discord tab in `SESSION.injectHealth` (keyed by tab id) and
 * forgets tabs that are closed. The popup's "buttons could not be added" banner reads the latest one through `status/get`.
 */
import { SESSION } from '@/shared';
import type { BgResponse, InjectHealth } from '@/shared';
import { fail, invalid, ok } from './response';
import { getSession, sessionLock } from './store';
import { queryDiscordTabs } from './tabs';
import { isRecord } from './util';

const MAX_REASON_LENGTH = 200;
const MAX_TABS = 50;

type HealthMap = Record<string, InjectHealth>;

function parseHealth(raw: unknown): InjectHealth | null {
  if (!isRecord(raw)) return null;
  const { ok: healthy, reason, checkedAt } = raw;
  if (typeof healthy !== 'boolean') return null;
  if (reason !== null && typeof reason !== 'string') return null;
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return null;
  return {
    ok: healthy,
    reason: reason === null ? null : reason.slice(0, MAX_REASON_LENGTH),
    checkedAt,
  };
}

function parseHealthMap(raw: unknown): HealthMap {
  const map: HealthMap = {};
  if (!isRecord(raw)) return map;
  for (const [tabId, value] of Object.entries(raw)) {
    if (!/^\d+$/.test(tabId)) continue;
    const health = parseHealth(value);
    if (health !== null) map[tabId] = health;
  }
  return map;
}

export async function readHealthMap(): Promise<HealthMap> {
  return parseHealthMap(await getSession(SESSION.injectHealth));
}

/** The most recent report (by `checkedAt`), ignoring tabs that are no longer open when `openTabIds` is given. */
export function latestHealth(map: HealthMap, openTabIds?: ReadonlySet<number>): InjectHealth | null {
  let latest: InjectHealth | null = null;
  for (const [tabId, health] of Object.entries(map)) {
    if (openTabIds && !openTabIds.has(Number(tabId))) continue;
    if (latest === null || health.checkedAt > latest.checkedAt) latest = health;
  }
  return latest;
}

/** `inject/health` from a content script: store the report under its tab id and prune the tabs that have gone. */
export async function recordHealth(raw: unknown, sender: chrome.runtime.MessageSender): Promise<BgResponse> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return fail('invalid', 'inject/health must come from a tab');
  const health = parseHealth(raw);
  if (health === null) return invalid('health is malformed');

  const openIds = new Set((await queryDiscordTabs()).flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
  await sessionLock.run(async () => {
    const map = parseHealthMap(await getSession(SESSION.injectHealth));
    map[String(tabId)] = health;
    const known = openIds.size > 0 ? Object.keys(map).filter((id) => openIds.has(Number(id)) || id === String(tabId)) : Object.keys(map);
    const pruned: HealthMap = {};
    // newest reports win when the map is too big (a browser with dozens of Discord tabs)
    for (const id of known.sort((a, b) => map[b].checkedAt - map[a].checkedAt).slice(0, MAX_TABS)) pruned[id] = map[id];
    await chrome.storage.session.set({ [SESSION.injectHealth]: pruned });
  });
  return ok();
}

/** A tab was closed: its report goes. */
export function removeHealth(tabId: number): Promise<void> {
  return sessionLock.run(async () => {
    const map = parseHealthMap(await getSession(SESSION.injectHealth));
    if (!(String(tabId) in map)) return;
    delete map[String(tabId)];
    await chrome.storage.session.set({ [SESSION.injectHealth]: map });
  });
}
