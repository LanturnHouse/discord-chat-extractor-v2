import type { ChatTarget, ExportFormat, ExportSettings } from '@/shared';
import type { NumberFormatter } from '../i18n/locale';
import { isoToDateInput } from './dates';
import type { summaryStrings } from './strings';

type SummaryStrings = (typeof summaryStrings)['en'];

/** Card title of a format (the format name and file extension, the same in every language). */
export const FORMAT_NAMES: Readonly<Record<ExportFormat, string>> = Object.freeze({
  html: 'HTML',
  txt: 'TXT',
  md: 'Markdown',
  xlsx: 'Excel (.xlsx)',
  csv: 'CSV',
  json: 'JSON',
});

/** Short tag shown on the download button and in the summary line. */
export const FORMAT_CHIPS: Readonly<Record<ExportFormat, string>> = Object.freeze({
  html: 'HTML',
  txt: 'TXT',
  md: 'MD',
  xlsx: 'XLSX',
  csv: 'CSV',
  json: 'JSON',
});

/**
 * The list label of a chat (docs/PLAN.md §7.2): `서버 > #채널` for a channel, `서버 > #부모 > 스레드` for a thread, the
 * person's / group's name for a DM. A missing server name (the content script could not read it yet) just leaves it out.
 */
export function formatTargetLabel(target: ChatTarget): string {
  const name = target.channelName.trim() === '' ? target.channelId : target.channelName;
  if (target.kind === 'dm' || target.kind === 'group-dm') return name;
  const guild = target.guildName?.trim() ?? '';
  const parts: string[] = [];
  if (guild !== '') parts.push(guild);
  if (target.kind === 'thread') {
    const parent = target.parentName?.trim() ?? '';
    if (parent !== '') parts.push(`#${parent}`);
    parts.push(name);
  } else {
    parts.push(`#${name}`);
  }
  return parts.join(' > ');
}

/** The date range of `settings` in words ("기간 없음", "2026-01-01부터", "2026-01-01 ~ 2026-01-31"), by local calendar days. */
export function describeRange(settings: Pick<ExportSettings, 'from' | 'to'>, t: SummaryStrings): string {
  const from = isoToDateInput(settings.from);
  const to = isoToDateInput(settings.to);
  if (from === '' && to === '') return t.noRange;
  if (to === '') return t.from(from);
  if (from === '') return t.until(to);
  return t.between(from, to);
}

/**
 * The one-line summary of the EFFECTIVE settings of a queue item: `200개 · HTML · 기간 없음` plus ` · 첨부`, ` · 스레드` and
 * ` · 새 메시지만` for the extras that are switched on (docs/PLAN.md §7.2).
 */
export function summarizeSettings(settings: ExportSettings, t: SummaryStrings, fmt: NumberFormatter): string {
  const parts = [settings.count === null ? t.all : t.count(settings.count, fmt), FORMAT_CHIPS[settings.format], describeRange(settings, t)];
  if (settings.includeAttachments) parts.push(t.attachments);
  if (settings.includeThreads) parts.push(t.threads);
  if (settings.incremental) parts.push(t.incremental);
  return parts.join(' · ');
}

/** Only these hosts may serve an avatar: the extension's CSP allows nothing else, and anything else would just be a broken image. */
const IMAGE_HOSTS: readonly string[] = ['cdn.discordapp.com', 'media.discordapp.net'];

/** `url` when it is a Discord CDN image (https) or an inline data image, otherwise null. */
export function safeImageUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && IMAGE_HOSTS.includes(parsed.hostname) ? url : null;
  } catch {
    return null;
  }
}

/**
 * `url` when it is an https address on `cdn.discordapp.com` itself (no other host, no port, no credentials in front), otherwise
 * null. Server icons use this stricter check than `safeImageUrl`: the background only ever records icons of that one host.
 */
export function discordCdnUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URL(url);
    const plain = parsed.protocol === 'https:' && parsed.hostname === 'cdn.discordapp.com' && parsed.port === '' && parsed.username === '' && parsed.password === '';
    return plain ? url : null;
  } catch {
    return null;
  }
}
