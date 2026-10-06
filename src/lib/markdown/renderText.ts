import type { MarkdownContext, MdNode } from './types';

type TimestampStyle = Extract<MdNode, { type: 'timestamp' }>['style'];
type ListNode = Extract<MdNode, { type: 'list' }>;

// ---------------------------------------------------------------------------------------------------------------------
// helpers shared with renderHtml.ts (labels and date formatting must be identical everywhere)
// ---------------------------------------------------------------------------------------------------------------------

const UNKNOWN_USER = { ko: '@알 수 없는 사용자', en: '@Unknown User' } as const;
const UNKNOWN_ROLE = { ko: '@삭제된-역할', en: '@deleted-role' } as const;
const UNKNOWN_CHANNEL = { ko: '#알 수 없는 채널', en: '#unknown-channel' } as const;

/** Visible label of a mention node ("@name", "#channel", "@everyone" ...), or null for other node types. */
export function mentionLabel(node: MdNode, ctx: MarkdownContext): string | null {
  switch (node.type) {
    case 'mentionUser': {
      const name = ctx.names.user(node.id);
      return name ? `@${name}` : UNKNOWN_USER[ctx.locale];
    }
    case 'mentionRole': {
      const name = ctx.names.role(node.id);
      return name ? `@${name}` : UNKNOWN_ROLE[ctx.locale];
    }
    case 'mentionChannel': {
      const name = ctx.names.channel(node.id);
      return name ? `#${name}` : UNKNOWN_CHANNEL[ctx.locale];
    }
    case 'mentionEveryone':
      return '@everyone';
    case 'mentionHere':
      return '@here';
    default:
      return null;
  }
}

const intlLocale = (locale: MarkdownContext['locale']): string => (locale === 'ko' ? 'ko-KR' : 'en-US');

// dateStyle 'short' would give a two-digit year ("11/28/18"); Discord shows the full year.
const SHORT_DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };

const STYLE_OPTIONS: Record<Exclude<TimestampStyle, 'R'>, { date?: Intl.DateTimeFormatOptions; time?: Intl.DateTimeFormatOptions }> = {
  t: { time: { timeStyle: 'short' } },
  T: { time: { timeStyle: 'medium' } },
  d: { date: SHORT_DATE },
  D: { date: { dateStyle: 'long' } },
  f: { date: { dateStyle: 'long' }, time: { timeStyle: 'short' } },
  F: { date: { dateStyle: 'full' }, time: { timeStyle: 'short' } },
  s: { date: SHORT_DATE, time: { timeStyle: 'short' } },
  S: { date: SHORT_DATE, time: { timeStyle: 'medium' } },
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let fmt = formatterCache.get(key);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }); // invalid IANA zone
    }
    formatterCache.set(key, fmt);
  }
  return fmt;
}

/**
 * Absolute date/time for a `<t:unix:style>` token in ctx.timeZone / ctx.locale. Static output has no "now", so the
 * relative style R is rendered like the default style f. Narrow no-break spaces (newer ICU) are normalised so that
 * the text is identical across platforms.
 */
export function formatTimestamp(unix: number, style: TimestampStyle, ctx: MarkdownContext): string {
  const date = new Date(unix * 1000);
  if (Number.isNaN(date.getTime())) return String(unix);
  const spec = STYLE_OPTIONS[style === 'R' ? 'f' : style];
  const locale = intlLocale(ctx.locale);
  const parts: string[] = [];
  if (spec.date) parts.push(formatter(locale, ctx.timeZone, spec.date).format(date));
  if (spec.time) parts.push(formatter(locale, ctx.timeZone, spec.time).format(date));
  return parts.join(' ').replace(/[  ]/g, ' ');
}

/** "in 3 hours" / "2일 전" relative to `nowMs` (the in-app view; exported files never use it). */
export function formatRelativeTime(unix: number, locale: MarkdownContext['locale'], nowMs: number = Date.now()): string {
  const diff = unix - nowMs / 1000;
  const abs = Math.abs(diff);
  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (abs < 60) [value, unit] = [Math.trunc(diff), 'second'];
  else if (abs < 3600) [value, unit] = [Math.trunc(diff / 60), 'minute'];
  else if (abs < 86400) [value, unit] = [Math.trunc(diff / 3600), 'hour'];
  else if (abs < 30 * 86400) [value, unit] = [Math.trunc(diff / 86400), 'day'];
  else if (abs < 365 * 86400) [value, unit] = [Math.trunc(diff / (30 * 86400)), 'month'];
  else [value, unit] = [Math.trunc(diff / (365 * 86400)), 'year'];
  return new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' }).format(value, unit);
}

// ---------------------------------------------------------------------------------------------------------------------
// plain text
// ---------------------------------------------------------------------------------------------------------------------

const BLOCK_TYPES: ReadonlySet<MdNode['type']> = new Set<MdNode['type']>(['codeBlock', 'blockQuote', 'heading', 'subtext', 'list']);

function renderInlineCode(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function renderList(node: ListNode, ctx: MarkdownContext, level: number): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(level);
  node.items.forEach((item, index) => {
    const inline: MdNode[] = [];
    const nested: ListNode[] = [];
    for (const child of item) {
      if (child.type === 'list') nested.push(child);
      else inline.push(child);
    }
    const marker = node.ordered ? `${node.start + index}.` : '-';
    lines.push(`${indent}${marker} ${renderNodes(inline, ctx)}`);
    for (const list of nested) lines.push(...renderList(list, ctx, level + 1));
  });
  return lines;
}

function renderNode(node: MdNode, ctx: MarkdownContext): string {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'br':
      return '\n';
    case 'strong':
    case 'em':
    case 'underline':
      return renderNodes(node.children, ctx);
    case 'strike':
      return `~~${renderNodes(node.children, ctx)}~~`;
    case 'spoiler':
      return `||${renderNodes(node.children, ctx)}||`;
    case 'inlineCode':
      return renderInlineCode(node.text);
    case 'codeBlock':
      return `\`\`\`${node.lang ?? ''}\n${node.text}\n\`\`\``;
    case 'blockQuote':
      return renderNodes(node.children, ctx)
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');
    case 'heading':
      return `${'#'.repeat(node.level)} ${renderNodes(node.children, ctx)}`;
    case 'subtext':
      return `-# ${renderNodes(node.children, ctx)}`;
    case 'list':
      return renderList(node, ctx, 0).join('\n');
    case 'link': {
      const text = renderNodes(node.children, ctx);
      return !node.masked || text === node.url ? text : `${text} (${node.url})`;
    }
    case 'emoji':
      return `:${node.name}:`;
    case 'timestamp':
      return formatTimestamp(node.unix, node.style, ctx);
    default:
      return mentionLabel(node, ctx) ?? '';
  }
}

/**
 * Block nodes (code block, quote, heading, subtext, list) always sit on their own lines; the parser swallowed the
 * newline that separated them from their neighbours, so it is re-inserted here.
 */
function renderNodes(nodes: MdNode[], ctx: MarkdownContext): string {
  const parts: string[] = [];
  let needNewline = false;
  let started = false;
  for (const node of nodes) {
    const block = BLOCK_TYPES.has(node.type);
    if (needNewline || (block && started)) parts.push('\n');
    parts.push(renderNode(node, ctx));
    started = true;
    needNewline = block;
  }
  return parts.join('');
}

/** Readable plain text for TXT / spreadsheet / CSV exports. */
export function renderText(nodes: MdNode[], ctx: MarkdownContext): string {
  return renderNodes(nodes, ctx);
}
