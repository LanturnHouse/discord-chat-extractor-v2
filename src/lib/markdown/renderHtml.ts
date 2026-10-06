import { emojiUrl } from '../discord/cdn';
import { linkHostNote, misleadingLinkHost } from './linkHost';
import { splitUnicodeEmoji } from './parse';
import { formatTimestamp, mentionLabel, renderText } from './renderText';
import type { MarkdownContext, MdNode } from './types';
import { safeMediaUrl, safeUrl } from './url';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML text nodes and for double- or single-quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

export interface RenderHtmlOptions {
  /** Enlarge emoji (message that consists only of emoji). The caller decides, usually via isEmojiOnly(). */
  jumbo?: boolean;
}

const LINK_REL = 'noopener noreferrer nofollow';

function renderChildren(nodes: MdNode[], ctx: MarkdownContext, jumbo: boolean): string {
  let html = '';
  for (const node of nodes) html += renderNode(node, ctx, jumbo);
  return html;
}

function renderTextNode(text: string, jumbo: boolean): string {
  if (!jumbo) return escapeHtml(text);
  let html = '';
  for (const run of splitUnicodeEmoji(text)) {
    html += run.emoji ? `<span class="md-emoji-jumbo">${escapeHtml(run.text)}</span>` : escapeHtml(run.text);
  }
  return html;
}

function renderNode(node: MdNode, ctx: MarkdownContext, jumbo: boolean): string {
  switch (node.type) {
    case 'text':
      return renderTextNode(node.text, jumbo);
    case 'br':
      return '<br>';
    case 'strong':
      return `<strong>${renderChildren(node.children, ctx, jumbo)}</strong>`;
    case 'em':
      return `<em>${renderChildren(node.children, ctx, jumbo)}</em>`;
    case 'underline':
      return `<u>${renderChildren(node.children, ctx, jumbo)}</u>`;
    case 'strike':
      return `<s>${renderChildren(node.children, ctx, jumbo)}</s>`;
    case 'spoiler':
      return `<span class="md-spoiler" tabindex="0">${renderChildren(node.children, ctx, jumbo)}</span>`;
    case 'inlineCode':
      return `<code class="md-code">${escapeHtml(node.text)}</code>`;
    case 'codeBlock': {
      const lang = node.lang ? ` data-lang="${escapeHtml(node.lang)}"` : '';
      return `<pre class="md-pre"${lang}><code>${escapeHtml(node.text)}</code></pre>`;
    }
    case 'blockQuote':
      return `<blockquote class="md-quote">${renderChildren(node.children, ctx, jumbo)}</blockquote>`;
    case 'heading':
      return `<div class="md-heading md-h${node.level}" role="heading" aria-level="${node.level}">${renderChildren(node.children, ctx, jumbo)}</div>`;
    case 'subtext':
      return `<div class="md-subtext">${renderChildren(node.children, ctx, jumbo)}</div>`;
    case 'list': {
      const items = node.items.map((item) => `<li>${renderChildren(item, ctx, jumbo)}</li>`).join('');
      if (!node.ordered) return `<ul class="md-list">${items}</ul>`;
      const start = Number.isSafeInteger(node.start) && node.start !== 1 ? ` start="${node.start}"` : '';
      return `<ol class="md-list"${start}>${items}</ol>`;
    }
    case 'link': {
      const inner = renderChildren(node.children, ctx, jumbo);
      const href = safeUrl(node.url, { allowMailto: true });
      if (href === null) return inner;
      const title = node.masked ? ` title="${escapeHtml(href)}"` : '';
      // The text names another site than the link opens (`[https://discord.com/login](https://evil.example)`): say where it goes.
      const host = node.masked ? misleadingLinkHost(renderText(node.children, ctx), href) : null;
      const note = host === null ? '' : `<span class="md-link-host">${escapeHtml(linkHostNote(host))}</span>`;
      return `<a class="md-link" href="${escapeHtml(href)}" target="_blank" rel="${LINK_REL}"${title}>${inner}${note}</a>`;
    }
    case 'emoji': {
      const src = safeMediaUrl(emojiUrl(node.id, node.animated));
      const alt = escapeHtml(`:${node.name}:`);
      if (src === null) return alt;
      const cls = jumbo ? 'md-emoji md-emoji-jumbo' : 'md-emoji';
      return `<img class="${cls}" alt="${alt}" title="${alt}" src="${escapeHtml(src)}" loading="lazy" decoding="async" draggable="false">`;
    }
    case 'timestamp': {
      const date = new Date(node.unix * 1000);
      const text = escapeHtml(formatTimestamp(node.unix, node.style, ctx));
      if (Number.isNaN(date.getTime())) return text;
      const title = escapeHtml(formatTimestamp(node.unix, 'F', ctx));
      return `<time class="md-time" datetime="${date.toISOString()}" title="${title}">${text}</time>`;
    }
    default:
      return `<span class="md-mention">${escapeHtml(mentionLabel(node, ctx) ?? '')}</span>`;
  }
}

/**
 * HTML for the exported file. Output contains no script, no event handlers and no inline styles: all text and
 * attribute values are escaped, links go through safeUrl() (http/https/mailto only) and images only come from the CDN
 * builders. Class names (md-*) belong to markdown.css (formats/html/).
 */
export function renderHtml(nodes: MdNode[], ctx: MarkdownContext, opts: RenderHtmlOptions = {}): string {
  return renderChildren(nodes, ctx, opts.jumbo === true);
}
