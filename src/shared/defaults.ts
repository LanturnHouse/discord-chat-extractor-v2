/**
 * Default values, constants and the effective-settings helper (docs/PLAN.md §5.4). The default objects are deep-frozen: copy
 * them (`structuredClone`, or `{ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_CONTENT_OPTIONS } }`) before editing, so
 * one stray mutation can never change the defaults for the rest of the session.
 *
 * The request allow-lists (`TRANSPORT_ALLOWLIST`, `API_GET_ALLOWLIST`) live in ./allowlist.ts.
 */
import type { AppSettings, ContentOptions, ExportSettings, QueueItem } from './types.ts';

export const DEFAULT_CONTENT_OPTIONS: ContentOptions = /* @__PURE__ */ Object.freeze({
  includeBots: true,
  includeSystem: true,
  includeReactions: true,
  includeEmbeds: true,
});

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = /* @__PURE__ */ Object.freeze({
  count: 200,
  from: null,
  to: null,
  format: 'html',
  htmlTheme: 'dark',
  includeAttachments: false,
  includeThreads: false,
  incremental: false,
  content: DEFAULT_CONTENT_OPTIONS,
});

export const DEFAULT_APP_SETTINGS: AppSettings = /* @__PURE__ */ Object.freeze({
  common: DEFAULT_EXPORT_SETTINGS,
  showButtons: true,
  showQueuedIndicator: false,
  zipAll: false,
  folderName: 'Discord Export',
  dateInFileName: true,
  timeZone: 'auto',
  notifyOnComplete: true,
  language: 'auto',
  consentAt: null,
});

/** The Discord web client origins the content script runs on. */
export const DISCORD_ORIGINS: readonly string[] = /* @__PURE__ */ Object.freeze([
  'https://discord.com',
  'https://ptb.discord.com',
  'https://canary.discord.com',
]);

/** Every API path the extension requests starts with this (v9, like the web client). */
export const API_BASE_PATH = '/api/v9';

/**
 * The settings an export of `item` runs with (docs/PLAN.md §3, §6.3): the item's own settings when it has any, otherwise the
 * common settings (`item.settings ?? common`). Always a fresh deep copy: the caller may edit the result without touching the
 * item, the common settings or the frozen defaults. The background worker calls it once, when a job starts, so changing the
 * common settings later does not affect a running job.
 */
export function resolveItemSettings(item: Pick<QueueItem, 'settings'>, common: ExportSettings): ExportSettings {
  return structuredClone(item.settings ?? common);
}
