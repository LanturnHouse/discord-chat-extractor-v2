/**
 * Shared set-up of the tests that run a whole chat through `exportChat` against the demo world (no network, no timers):
 * a chat target, settings with a given format, and the context the engine would build.
 */
import { DEFAULT_EXPORT_SETTINGS } from '@/shared/defaults';
import type { ChatTarget, ExportFormat, ExportSettings } from '@/shared/types';
import { createMockClient, MOCK_IDS } from '../../../src/lib/discord/mock';
import type { MockDiscordClient } from '../../../src/lib/discord/mock';
import { exportChat } from '../../../src/lib/export/chat';
import type { ChatOutput, ExportChatContext, ExportChatResult } from '../../../src/lib/export/chat';

/** 2026-10-06 12:00:00 UTC = 21:00 in Seoul. */
export const NOW = new Date('2026-10-06T12:00:00Z');

/** What the content script would send for a channel: names only from the DOM, possibly stale or wrong. */
export function target(channelId: string, overrides: Partial<ChatTarget> = {}): ChatTarget {
  return { kind: 'guild-channel', channelId, guildId: MOCK_IDS.bigGuild, guildName: 'from the DOM', channelName: 'from the DOM', ...overrides };
}

export function settings(format: ExportFormat, overrides: Partial<ExportSettings> = {}): ExportSettings {
  return { ...structuredClone(DEFAULT_EXPORT_SETTINGS), count: null, format, ...overrides };
}

export function context(overrides: Partial<ExportChatContext> = {}): ExportChatContext {
  return { timeZone: 'Asia/Seoul', locale: 'en', lastExportedId: null, dateInFileName: true, folderName: 'Discord Export', now: () => NOW, ...overrides };
}

export const mock = (): MockDiscordClient => createMockClient({ latencyMs: 0 });

/** Exports one chat of the demo world. */
export function exportMock(
  channelId: string,
  format: ExportFormat,
  overrides: { target?: Partial<ChatTarget>; settings?: Partial<ExportSettings>; ctx?: Partial<ExportChatContext>; client?: MockDiscordClient } = {},
): Promise<ExportChatResult> {
  return exportChat(overrides.client ?? mock(), target(channelId, overrides.target), settings(format, overrides.settings), context(overrides.ctx));
}

export const textOf = (output: ChatOutput): string => (typeof output.data === 'string' ? output.data : new TextDecoder('utf-8', { ignoreBOM: true }).decode(output.data));

export const bytesOf = (output: ChatOutput): Uint8Array => (typeof output.data === 'string' ? new TextEncoder().encode(output.data) : output.data);
