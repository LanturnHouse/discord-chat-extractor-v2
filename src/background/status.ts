/** `status/get` (the popup's picture of the world) and `settings/patch`. */
import type { BgResponse, StatusSnapshot } from '@/shared';
import { ensureAccount } from './account';
import { latestHealth, readHealthMap } from './health';
import { invalid, ok } from './response';
import { patchSettings, readAccount, readJob, readLastAccount, updateBgState } from './store';
import { queryDiscordTabs } from './tabs';
import { validateSettingsPatch } from './validate';

/**
 * `status/get`: the current account, the last one, how many Discord tabs are open, the newest injection report of an open
 * tab and the job. Opening the popup also acknowledges a failed job: the red `!` badge goes (the badge follows the
 * private state change), and a missing account is looked up again (self-healing, throttled).
 */
export async function getStatus(): Promise<BgResponse<StatusSnapshot>> {
  const [account, lastAccount, tabs, job, healthMap] = await Promise.all([
    readAccount(),
    readLastAccount(),
    queryDiscordTabs(),
    readJob(),
    readHealthMap(),
  ]);
  await updateBgState((state) => {
    state.alert = false;
  });
  ensureAccount();
  const openTabIds = new Set(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
  return ok({ account, lastAccount, discordTabs: tabs.length, health: latestHealth(healthMap, openTabIds), job });
}

/** `settings/patch`: a shallow patch of the app settings, `common` replaced whole; types and ranges are validated. */
export async function patchSettingsMessage(rawPatch: unknown): Promise<BgResponse> {
  const checked = validateSettingsPatch(rawPatch);
  if (!checked.ok) return invalid(checked.message);
  if (Object.keys(checked.value).length > 0) await patchSettings(checked.value);
  return ok();
}
