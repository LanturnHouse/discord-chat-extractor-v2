import { emojiUrl } from '../../discord/cdn';
import { linkHostNote, misleadingLinkHost } from '../../markdown/linkHost';
import { parseMarkdown } from '../../markdown/parse';
import { formatTimestamp, mentionLabel, renderText } from '../../markdown/renderText';
import type { MarkdownContext, MdNode } from '../../markdown/types';
import { safeUrl } from '../../markdown/url';
import { cleanText, oneLine } from './text';

/**
 * Discord markdown AST -> CommonMark / GFM text for the Markdown export.
 *
 * Message text is attacker-controlled and ends up in notes apps and repositories, so the renderer re-emits only what
 * the parser recognised as formatting and escapes everything else. In particular:
 *  - `<` is always escaped, so message text can never open an HTML tag, comment or autolink; the only raw HTML in the
 *    output is the `<sub>` the exporter itself writes;
 *  - `[`, `]` and backticks are escaped, so literal text can never become a link (for example "[x](javascript:...)")
 *    or an image;
 *  - a line that would start a heading, quote, list, rule or indented code block in CommonMark is escaped at its
 *    first character, so message text cannot forge document structure; Discord headings are demoted to levels 4-6 so
 *    they never compete with the title and day headings of the document;
 *  - link destinations are re-checked with `safeUrl` (http/https only), and a masked link whose text names another site
 *    gets the real host appended to that text (the same note the HTML export shows), because Markdown shows no destination.
 * Underline has no CommonMark syntax; it is written as `__x__` like in Discord (viewers show it bold).
 */

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const NEEDS_ESCAPE = /[\\`*_~[\]<&]/;
const ESCAPABLE = /[\\`*_~[\]<&]/g;
/** `&amp;`, `&#60;` ...: text that a viewer would decode to something else. */
const ENTITY_AHEAD = /#?[A-Za-z0-9]{1,32};/y;
const HEADING_START = /^#{1,6}(?:\s|$)/;
const BULLET_START = /^[-+](?:\s|$)/;
const RULE_OR_SETEXT_DASHES = /^-+\s*$/;
const SETEXT_EQUALS = /^=+\s*$/;
const ORDERED_START = /^(\d{1,9})([.)])(?=\s|$)/;
const NBSP = String.fromCharCode(0xa0);
const HARD_BREAK = '  \n';
const EMOJI_SIZE = 32;

const isLetterOrDigit = (ch: string | undefined): boolean => ch !== undefined && LETTER_OR_DIGIT.test(ch);

/** Backslash-escapes the characters of `text` that CommonMark / GFM would read as syntax. */
function escapeCharacters(text: string): string {
  if (!NEEDS_ESCAPE.test(text)) return text;
  // GFM strikethrough also pairs single tildes, but a lone "~" (as in "오늘~") cannot pair inside one text node.
  const tildePairPossible = text.indexOf('~') !== text.lastIndexOf('~');
  return text.replace(ESCAPABLE, (ch, offset: number) => {
    switch (ch) {
      case '\\': {
        // Only a backslash before punctuation (or before whatever we write next) is an escape character.
        const next = text[offset + 1];
        return next === undefined || ASCII_PUNCTUATION.test(next) ? '\\\\' : '\\';
      }
      case '_':
        // snake_case is not emphasis in CommonMark; everything else could be.
        return isLetterOrDigit(text[offset - 1]) && isLetterOrDigit(text[offset + 1]) ? '_' : '\\_';
      case '~':
        return tildePairPossible ? '\\~' : '~';
      case '&':
        ENTITY_AHEAD.lastIndex = offset + 1;
        return ENTITY_AHEAD.test(text) ? '\\&' : '&';
      default:
        return `\\${ch}`;
    }
  });
}

/** Escapes what would turn the start of a line into a block construct. `rest` has no leading indentation. */
function escapeBlockStart(rest: string): string {
  switch (rest.charCodeAt(0)) {
    case 0x23: // #
      return HEADING_START.test(rest) ? `\\${rest}` : rest;
    case 0x3e: // >
      return `\\${rest}`;
    case 0x2d: // -
      return BULLET_START.test(rest) || RULE_OR_SETEXT_DASHES.test(rest) ? `\\${rest}` : rest;
    case 0x2b: // +
      return BULLET_START.test(rest) ? `\\${rest}` : rest;
    case 0x3d: // =
      return SETEXT_EQUALS.test(rest) ? `\\${rest}` : rest;
    default:
      return rest.charCodeAt(0) >= 0x30 && rest.charCodeAt(0) <= 0x39 ? rest.replace(ORDERED_START, '$1\\$2') : rest;
  }
}

function escapeLineStart(text: string): string {
  let end = 0;
  while (end < text.length && (text.charCodeAt(end) === 0x20 || text.charCodeAt(end) === 0x09)) end += 1;
  const indent = text.slice(0, end).replace(/\t/g, '    ');
  // Four columns of indentation start a code block; no-break spaces look the same but are not indentation.
  const shown = indent.length >= 4 ? NBSP.repeat(indent.length) : indent;
  return shown + escapeBlockStart(text.slice(end));
}

/** Text that is part of a paragraph; `lineStart` says whether it begins a line (block syntax must be escaped there). */
export function escapeText(text: string, lineStart: boolean): string {
  const escaped = escapeCharacters(text);
  return lineStart ? escapeLineStart(escaped) : escaped;
}

/** Single-line plain text (names, titles, file names) made safe for the middle of a line. */
export function escapeInline(value: unknown): string {
  return escapeCharacters(oneLine(value));
}

/** `(...)` and spaces would end an inline link destination early, `<`/`>`/`\` would break the `<...>` form. */
export function mdDestination(href: string): string {
  const encoded = href.replace(/[<>\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return /[()\s]/.test(encoded) ? `<${encoded}>` : encoded;
}

/** `[label](url)`; the bare label when `url` is not an http(s) URL. `label` must already be escaped. */
export function mdLink(label: string, url: string | null | undefined): string {
  const href = safeUrl(url);
  return href === null ? label : `[${label}](${mdDestination(href)})`;
}

/** Longest run of backticks in `text`: a code delimiter has to be longer than that. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

export function mdInlineCode(text: string): string {
  // CommonMark turns line endings inside a code span into spaces; doing it here keeps the span on one line.
  const body = text.replace(/\n/g, ' ');
  const delimiter = '`'.repeat(longestBacktickRun(body) + 1);
  const needsPadding = body.startsWith('`') || body.endsWith('`') || (body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '');
  const pad = needsPadding ? ' ' : '';
  return `${delimiter}${pad}${body}${pad}${delimiter}`;
}

export function mdCodeBlock(lang: string | null, text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  const info = (lang ?? '').replace(/[^\w+#.-]/g, '');
  return `${fence}${info}\n${text}\n${fence}`;
}

/** Prefixes every line with `> ` (empty lines with a bare `>`, so the quote stays one block). */
export function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

type ListNode = Extract<MdNode, { type: 'list' }>;
type LinkNode = Extract<MdNode, { type: 'link' }>;

const BLOCK_TYPES: ReadonlySet<MdNode['type']> = new Set<MdNode['type']>(['codeBlock', 'blockQuote', 'heading', 'subtext', 'list']);

const PARAGRAPH_BREAK = '\n\n';

const isMaskedLink = (node: MdNode | undefined): boolean => node !== undefined && node.type === 'link' && node.masked;

function dropTrailingBreaks(parts: string[]): void {
  while (parts.length > 0 && (parts[parts.length - 1] === HARD_BREAK || parts[parts.length - 1] === PARAGRAPH_BREAK)) parts.pop();
}

/** Characters an autolink (`<url>`) cannot contain. */
const NOT_AUTOLINKABLE = /[\s<>\u0000-\u001F\u007F]/;

/**
 * `<url>`: an autolink shows the URL itself and, unlike a bare URL, cannot be torn apart by emphasis characters inside
 * it. The URL as written is used when an autolink can carry it, else its normalised form; null for anything that is
 * not an http(s) URL.
 */
export function mdAutolink(url: string): string | null {
  const href = safeUrl(url);
  if (href === null) return null;
  const shown = NOT_AUTOLINKABLE.test(url) ? href : url;
  return NOT_AUTOLINKABLE.test(shown) ? null : `<${shown}>`;
}

class Renderer {
  /** True while the next character written starts a line (block syntax would be recognised there). */
  private lineStart = true;
  /** Mentions are bold, which cannot nest inside bold. */
  private strongDepth = 0;
  /** The node being rendered is directly followed by a `[text](url)` link. */
  private beforeLink = false;

  constructor(private readonly ctx: MarkdownContext) {}

  /**
   * Block nodes always sit on their own lines. The parser swallowed the newline that separated them from their
   * neighbours; a blank line is written back, which also stops a quote or list from swallowing the text after it.
   */
  blocks(nodes: readonly MdNode[]): string {
    const parts: string[] = [];
    let started = false;
    let previousBlock = false;
    this.lineStart = true;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.type === 'br') {
        // One newline is a hard break; a run of them is a blank line, i.e. a paragraph break. Right after a block
        // (or before any content) the blank line is already there.
        let run = 1;
        while (i + 1 < nodes.length && nodes[i + 1].type === 'br') {
          run += 1;
          i += 1;
        }
        this.lineStart = true;
        if (started && !previousBlock) parts.push(run === 1 ? HARD_BREAK : PARAGRAPH_BREAK);
        continue;
      }
      const block = BLOCK_TYPES.has(node.type);
      if (started && (block || previousBlock)) {
        dropTrailingBreaks(parts);
        parts.push(PARAGRAPH_BREAK);
      }
      if (block || previousBlock) this.lineStart = true;
      this.beforeLink = isMaskedLink(nodes[i + 1]);
      parts.push(this.node(node));
      started = true;
      previousBlock = block;
    }
    dropTrailingBreaks(parts);
    return parts.join('');
  }

  private inline(nodes: readonly MdNode[]): string {
    let out = '';
    for (let i = 0; i < nodes.length; i += 1) {
      this.beforeLink = isMaskedLink(nodes[i + 1]);
      out += this.node(nodes[i]);
    }
    return out;
  }

  private node(node: MdNode): string {
    switch (node.type) {
      case 'text':
        return this.text(node.text);
      case 'br':
        this.lineStart = true;
        return HARD_BREAK;
      case 'strong':
        return this.wrap('**', node.children, true);
      case 'em':
        return this.wrap('*', node.children, false);
      case 'underline':
        return this.wrap('__', node.children, false);
      case 'strike':
        return this.wrap('~~', node.children, false);
      case 'spoiler':
        return this.wrap('||', node.children, false);
      case 'inlineCode':
        this.lineStart = false;
        return mdInlineCode(node.text);
      case 'codeBlock':
        return mdCodeBlock(node.lang, node.text);
      case 'blockQuote':
        return quoteLines(new Renderer(this.ctx).blocks(node.children));
      case 'heading': {
        this.lineStart = false;
        return `${'#'.repeat(node.level + 3)} ${this.inline(node.children)}`;
      }
      case 'subtext': {
        this.lineStart = false;
        return `<sub>${this.inline(node.children)}</sub>`;
      }
      case 'list':
        return this.list(node).join('\n');
      case 'link':
        return this.link(node);
      case 'emoji': {
        this.lineStart = false;
        const alt = escapeCharacters(`:${node.name}:`);
        // Only ever an image on Discord's own CDN; an id that is not a plain number is shown as text.
        return /^\d{1,25}$/.test(node.id) ? `![${alt}](${emojiUrl(node.id, node.animated, EMOJI_SIZE)})` : alt;
      }
      case 'timestamp':
        return this.text(formatTimestamp(node.unix, node.style, this.ctx));
      default:
        return this.mention(node);
    }
  }

  private text(raw: string): string {
    let out = escapeText(raw, this.lineStart);
    // "!" right before "[label](url)" would turn the link into an image, which a viewer fetches from any host.
    if (this.beforeLink && out.endsWith('!')) out = `${out.slice(0, -1)}\\!`;
    if (out !== '') this.lineStart = false;
    return out;
  }

  private wrap(marker: string, children: readonly MdNode[], strong: boolean): string {
    this.lineStart = false;
    if (strong) this.strongDepth += 1;
    const inner = this.inline(children);
    if (strong) this.strongDepth -= 1;
    this.lineStart = false;
    return inner === '' ? '' : `${marker}${inner}${marker}`;
  }

  private mention(node: MdNode): string {
    const label = mentionLabel(node, this.ctx);
    if (label === null) return '';
    const bold = this.strongDepth === 0;
    // Names are chosen by other people: single line, escaped like any other text.
    const text = escapeText(oneLine(label), bold ? false : this.lineStart);
    this.lineStart = false;
    return bold ? `**${text}**` : text;
  }

  private link(node: LinkNode): string {
    const href = safeUrl(node.url);
    if (href === null) return this.inline(node.children);
    this.lineStart = false;
    if (!node.masked) return mdAutolink(node.url) ?? this.text(node.url);
    const label = this.inline(node.children);
    this.lineStart = false;
    if (label === '') return '';
    // A Markdown link shows no destination, so a label that names another site (`[https://good.example](https://evil.example)`)
    // would spoof the reader: say where it goes, with the same note the HTML export uses.
    const host = misleadingLinkHost(renderText(node.children, this.ctx), href);
    const note = host === null ? '' : escapeCharacters(linkHostNote(host));
    return `[${label}${note}](${mdDestination(href)})`;
  }

  private list(node: ListNode): string[] {
    const lines: string[] = [];
    node.items.forEach((item, index) => {
      const marker = node.ordered ? `${node.start + index}.` : '-';
      const inline: MdNode[] = [];
      const nested: ListNode[] = [];
      for (const child of item) {
        if (child.type === 'list') nested.push(child);
        else inline.push(child);
      }
      // A list item may start with any block construct ("- # x" is a heading inside the item, "- > x" a quote), so the
      // text after the marker is escaped like the start of a paragraph.
      this.lineStart = true;
      lines.push(`${marker} ${this.inline(inline)}`);
      const indent = ' '.repeat(marker.length + 1);
      for (const list of nested) {
        for (const line of this.list(list)) lines.push(indent + line);
      }
    });
    return lines;
  }
}

export function renderMarkdown(nodes: readonly MdNode[], ctx: MarkdownContext): string {
  return new Renderer(ctx).blocks(nodes);
}

/** Discord message text -> Markdown (control characters removed first, result trimmed). */
export function markdownText(content: unknown, ctx: MarkdownContext): string {
  if (typeof content !== 'string' || content === '') return '';
  return renderMarkdown(parseMarkdown(cleanText(content)), ctx).trim();
}
