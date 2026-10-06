import type { Message } from '../../../discord/types';
import { escapeHtml } from '../../../markdown/renderHtml';
import type { Chunk, ExportLocale, ExportWriter, FormatModule, WriterContext, WriterSummary } from '../../types';
import { applyContentOptions } from '../content';
import { channelDisplay, channelPath } from '../parts';
import { formatStamp, GENERATOR_NAME, getExportStrings, oneLine, scopeRows, type ExportStrings } from '../text';
import { exportStyles } from './css';
import { createHtmlEnv, loadableImage, renderMessageItem } from './message';

/**
 * Self-contained, script-free HTML file that looks like the app's chat view. The file only ever fetches pictures and
 * media from Discord's hosts (or shows inline data: images); the CSP below enforces that even if a message slipped
 * something through, and forbids scripts, frames, forms, fonts and base-URI changes outright.
 */
const CSP_BASE = "default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * With saved attachment copies the file also shows pictures and plays media from its own folder: relative references resolve to
 * the file's own origin (`'self'`, or the `file:` scheme when it is opened from disk). Everything else stays as above.
 */
const CSP_WITH_LOCAL_FILES =
  "default-src 'none'; img-src 'self' file: https: data:; media-src 'self' file: https:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";

/** The `<meta http-equiv="Content-Security-Policy">` value for a file with / without saved attachment copies. */
export function contentSecurityPolicy(withLocalFiles: boolean): string {
  return withLocalFiles ? CSP_WITH_LOCAL_FILES : CSP_BASE;
}

interface HtmlStrings {
  /** CDN links to attachments are signed and stop working after a while. */
  linksMayExpire: string;
  /** The same note for a file whose attachments were saved next to it. */
  someLinksMayExpire: string;
  noMessages: string;
}

const HTML_STRINGS: Record<ExportLocale, HtmlStrings> = {
  en: {
    linksMayExpire:
      "Links to attachments and other media on Discord's servers expire after a while, so pictures and files in this export may stop loading.",
    someLinksMayExpire:
      "Attachments saved next to this file keep working. Other links to Discord's servers (avatars, embeds, attachments that were not saved) expire after a while.",
    noMessages: 'No messages were found for this export.',
  },
  ko: {
    linksMayExpire: 'Discord 서버의 첨부 파일·미디어 링크는 일정 시간이 지나면 만료되므로 이 파일의 이미지와 첨부 파일이 더 이상 표시되지 않을 수 있습니다.',
    someLinksMayExpire:
      '이 파일 옆에 저장된 첨부 파일은 계속 열립니다. 그 밖의 Discord 서버 링크(프로필 사진, 임베드, 저장되지 않은 첨부 파일)는 일정 시간이 지나면 만료됩니다.',
    noMessages: '내보낼 메시지가 없습니다.',
  },
};

const e = escapeHtml;

/** First letters of the first words of a name (at most three), for the circle that stands in for a missing icon. */
function acronymOf(name: string): string {
  const letters: string[] = [];
  for (const word of oneLine(name).split(' ')) {
    const first = Array.from(word)[0];
    if (first !== undefined) letters.push(first);
    if (letters.length === 3) break;
  }
  return letters.length === 0 ? '?' : letters.join('').toUpperCase();
}

function metaList(rows: ReadonlyArray<readonly [label: string, value: string]>): string {
  return `<dl class="dce-meta">${rows.map(([label, value]) => `<dt>${e(label)}</dt><dd>${e(value)}</dd>`).join('')}</dl>`;
}

function headerHtml(ctx: WriterContext, timeZone: string, strings: ExportStrings): string {
  const { target, options, exportedAt } = ctx;
  const guild = oneLine(target.guildName);
  const title = guild === '' ? channelDisplay(target) : guild;
  const topic = oneLine(target.topic);
  const icon = loadableImage(target.iconUrl);

  let html = '<header class="dce-header">';
  html +=
    icon === null
      ? `<span class="dce-header__acronym" aria-hidden="true">${e(acronymOf(title))}</span>`
      : `<img class="dce-header__icon" src="${e(icon)}" alt="" width="64" height="64">`;
  html += `<div class="dce-header__text"><h1 class="dce-header__title">${e(title)}</h1>`;
  if (guild !== '') html += `<div class="dce-header__channel">${e(channelPath(target))}</div>`;
  if (topic !== '') html += `<p class="dce-header__topic">${e(topic)}</p>`;
  html += metaList([
    ...scopeRows(options, timeZone),
    [strings.exportedAt, `${formatStamp(exportedAt.toISOString(), timeZone)} (${timeZone})`],
    [strings.generator, GENERATOR_NAME],
  ]);
  return `${html}</div></header>`;
}

function createHtmlWriter(ctx: WriterContext): ExportWriter {
  const { target, options } = ctx;
  const env = createHtmlEnv(ctx);
  const { timeZone } = env;
  const strings = getExportStrings(env.locale);
  const htmlStrings = HTML_STRINGS[env.locale];
  const theme = options.htmlTheme === 'light' ? 'light' : 'dark';
  const withLocalFiles = options.attachmentPaths !== undefined && options.attachmentPaths.size > 0;
  /** The message above the next one: grouping and day dividers depend on it across batch boundaries. */
  let previous: Message | undefined;

  return {
    start(): Chunk[] {
      const guild = oneLine(target.guildName);
      const title = guild === '' ? channelDisplay(target) : `${guild} - ${channelDisplay(target)}`;
      const lines = [
        '<!doctype html>',
        `<html lang="${env.locale}" data-theme="${theme}">`,
        '<head>',
        '<meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(withLocalFiles)}">`,
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="referrer" content="no-referrer">',
        `<meta name="generator" content="${GENERATOR_NAME}">`,
        `<meta name="color-scheme" content="${theme}">`,
        `<title>${e(title)}</title>`,
        `<style>${exportStyles()}</style>`,
        '</head>',
        '<body>',
        '<div class="dce-page">',
        headerHtml(ctx, timeZone, strings),
        '<main>',
        '',
      ];
      return [lines.join('\n')];
    },

    write(batch: readonly Message[]): Chunk[] {
      const parts: string[] = [];
      for (const message of applyContentOptions(batch, options.content)) {
        if (message === null || typeof message !== 'object') continue;
        parts.push(renderMessageItem(message, previous, env));
        previous = message;
      }
      return parts.length === 0 ? [] : [`${parts.join('\n')}\n`];
    },

    end(summary: WriterSummary): Chunk[] {
      const rows: Array<readonly [string, string]> = [[strings.messages, String(summary.messageCount)]];
      if (summary.firstTimestamp) rows.push([strings.firstMessage, formatStamp(summary.firstTimestamp, timeZone)]);
      if (summary.lastTimestamp) rows.push([strings.lastMessage, formatStamp(summary.lastTimestamp, timeZone)]);
      const lines: string[] = [];
      if (summary.messageCount === 0) lines.push(`<p class="dce-empty">${e(htmlStrings.noMessages)}</p>`);
      lines.push(
        '</main>',
        '<footer class="dce-footer">',
        metaList(rows),
        `<p class="dce-footer__note">${e(withLocalFiles ? htmlStrings.someLinksMayExpire : htmlStrings.linksMayExpire)}</p>`,
        '</footer>',
        '</div>',
        '</body>',
        '</html>',
      );
      return [`${lines.join('\n')}\n`];
    },
  };
}

export const htmlFormat: FormatModule = {
  id: 'html',
  label: 'HTML (.html)',
  extension: 'html',
  mime: 'text/html;charset=utf-8',
  createWriter: createHtmlWriter,
};
