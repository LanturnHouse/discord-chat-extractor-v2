import type { Snowflake } from '../discord/types';

/**
 * Discord-flavoured markdown AST. `parseMarkdown()` (parse.ts) produces it; the exporters consume it:
 *   - renderHtml.ts     -> HTML export (string output, everything escaped, URLs scheme-checked)
 *   - renderText.ts     -> TXT / MD-fallback / XLSX / CSV plain text
 */
export type MdNode =
  | { type: 'text'; text: string }
  | { type: 'br' }
  | { type: 'strong'; children: MdNode[] }
  | { type: 'em'; children: MdNode[] }
  | { type: 'underline'; children: MdNode[] }
  | { type: 'strike'; children: MdNode[] }
  | { type: 'spoiler'; children: MdNode[] }
  | { type: 'inlineCode'; text: string }
  | { type: 'codeBlock'; lang: string | null; text: string }
  | { type: 'blockQuote'; children: MdNode[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: MdNode[] }
  | { type: 'subtext'; children: MdNode[] }
  | { type: 'list'; ordered: boolean; start: number; items: MdNode[][] }
  | { type: 'link'; url: string; children: MdNode[]; masked: boolean }
  | { type: 'mentionUser'; id: Snowflake }
  | { type: 'mentionRole'; id: Snowflake }
  | { type: 'mentionChannel'; id: Snowflake }
  | { type: 'mentionEveryone' }
  | { type: 'mentionHere' }
  | { type: 'emoji'; name: string; id: Snowflake; animated: boolean } // custom guild emoji
  | { type: 'timestamp'; unix: number; style: 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R' | 's' | 'S' };

/** Resolves ids to display strings (without the leading @ / #). Return undefined when unknown. */
export interface NameResolver {
  user(id: Snowflake): string | undefined;
  channel(id: Snowflake): string | undefined;
  role(id: Snowflake): string | undefined;
}

export interface MarkdownContext {
  names: NameResolver;
  locale: 'ko' | 'en';
  timeZone: string; // IANA zone for <t:...> rendering
}
