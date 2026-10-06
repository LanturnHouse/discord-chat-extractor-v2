import { parseMarkdown } from '../markdown/parse';
import { formatTimestamp, mentionLabel } from '../markdown/renderText';
import type { MarkdownContext, MdNode } from '../markdown/types';
import { getStrings, type MessageLocale, type MessageStrings } from './strings';
import { oneLine } from './text';
import { formatDateTime } from './time';

/**
 * One line of plain text for previews (the replied-to line above a message). It goes through the same markdown parser and the same
 * label / date helpers as the full-fidelity text renderer (`renderText`), so a mention or `<t:...>` token reads the
 * same in a reply preview as in the message body; what differs is only that previews hide spoilers, drop code
 * fences, quote and heading marks and cut the result to `max` units.
 * The input is cut to SCAN_LIMIT first, which bounds the cost of the (linear-time) parser.
 */

const SCAN_LIMIT = 2000;

export interface PlainContext {
  strings: MessageStrings;
  /**
   * IANA zone for `<t:...>` tokens, so that they read like in the message body of the same export. Without it the
   * viewer's zone is unknown and the instant is written explicitly in UTC.
   */
  timeZone?: string;
  user(id: string): string | undefined;
  channel(id: string): string | undefined;
  role(id: string): string | undefined;
}

type ListNode = Extract<MdNode, { type: 'list' }>;

const BLOCK_TYPES: ReadonlySet<MdNode['type']> = new Set<MdNode['type']>(['codeBlock', 'blockQuote', 'heading', 'subtext', 'list']);

/** `getStrings` hands out one table per language, so the table identifies the language. */
const localeOf = (strings: MessageStrings): MessageLocale => (strings === getStrings('ko') ? 'ko' : 'en');

function utcText(unix: number): string {
  const date = new Date(unix * 1000);
  return Number.isFinite(date.getTime()) ? `${formatDateTime(date.toISOString(), 'UTC')} UTC` : '';
}

class PlainRenderer {
  private readonly markdown: MarkdownContext;

  constructor(private readonly ctx: PlainContext) {
    this.markdown = {
      names: { user: (id) => ctx.user(id), channel: (id) => ctx.channel(id), role: (id) => ctx.role(id) },
      locale: localeOf(ctx.strings),
      timeZone: ctx.timeZone ?? 'UTC',
    };
  }

  /** Block nodes sit on their own lines (the parser swallowed the newline that separated them from their neighbours). */
  nodes(nodes: readonly MdNode[]): string {
    let out = '';
    let previousBlock = false;
    nodes.forEach((node, index) => {
      const block = BLOCK_TYPES.has(node.type);
      if (index > 0 && (block || previousBlock)) out += '\n';
      out += this.node(node);
      previousBlock = block;
    });
    return out;
  }

  private node(node: MdNode): string {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'br':
        return '\n';
      case 'strong':
      case 'em':
      case 'underline':
      case 'strike':
      case 'link':
      case 'blockQuote':
      case 'heading':
      case 'subtext':
        return this.nodes(node.children);
      case 'spoiler':
        return this.ctx.strings.spoiler;
      case 'inlineCode':
      case 'codeBlock':
        return node.text;
      case 'list':
        return this.list(node);
      case 'emoji':
        return `:${node.name}:`;
      case 'timestamp':
        return this.ctx.timeZone === undefined ? utcText(node.unix) : formatTimestamp(node.unix, node.style, this.markdown);
      default:
        return mentionLabel(node, this.markdown) ?? '';
    }
  }

  private list(node: ListNode): string {
    const lines: string[] = [];
    node.items.forEach((item, index) => {
      const marker = node.ordered ? `${node.start + index}.` : '-';
      lines.push(`${marker} ${this.nodes(item.filter((child) => child.type !== 'list'))}`);
      for (const child of item) if (child.type === 'list') lines.push(this.list(child));
    });
    return lines.join('\n');
  }
}

/** Single line of text without markdown syntax. Spoilers are replaced by the localised "[spoiler]" marker. */
export function plainFromMarkdown(content: string, ctx: PlainContext, max = Number.POSITIVE_INFINITY): string {
  const head = content.length > SCAN_LIMIT ? content.slice(0, SCAN_LIMIT) : content;
  return oneLine(new PlainRenderer(ctx).nodes(parseMarkdown(head)), max);
}
