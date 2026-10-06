/**
 * Shared set-up and helpers of the HTML export tests (html.test.ts, htmlParity.test.ts, htmlSecurity.test.ts).
 *
 * The export's style block is built from three `?raw` stylesheet imports; vitest.config.ts (`test.css.include`) makes
 * them real files instead of the empty string vitest would otherwise hand out for every `*.css` module.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockClient, MOCK_IDS } from '../../../../src/lib/discord/mock';
import { collectMessages } from '../../../../src/lib/discord/collect';
import type { Message, User } from '../../../../src/lib/discord/types';
import { htmlFormat } from '../../../../src/lib/export/formats/html';
import type { Chunk, WriterOptions, ExportTarget, WriterContext, WriterSummary } from '../../../../src/lib/export/types';
import { buildNameResolver, type MessageNameResolver } from '../../../../src/lib/message';

/**
 * A file of the repository, resolved from this file's location (not from the working directory, which differs when
 * vitest is started with `--root` from elsewhere). `import.meta.url` is used as a string because the jsdom
 * environment's `URL` cannot resolve against it.
 */
export const repoFile = (relative: string): string => resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', relative);

export const ALICE: User = { id: '1000', username: 'alice', global_name: 'Alice' };
export const BOB: User = { id: '2000', username: 'bob', global_name: 'Bob' };
export const BOT: User = { id: '4000', username: 'helper', bot: true };

export const OPTIONS: WriterOptions = { after: null, before: null, limit: null, htmlTheme: 'dark', locale: 'en', timeZone: 'UTC' };

export const SERVER_TARGET: ExportTarget = {
  channelId: '555',
  kind: 'text',
  channelName: 'general',
  guildId: '777',
  guildName: 'My Server',
  categoryName: 'Text Channels',
  parentChannelName: null,
  topic: 'Welcome!',
};

export const DM_TARGET: ExportTarget = {
  channelId: '556',
  kind: 'dm',
  channelName: 'Bob',
  guildId: null,
  guildName: null,
  categoryName: null,
  parentChannelName: null,
  topic: null,
};

export const THREAD_TARGET: ExportTarget = {
  channelId: '557',
  kind: 'thread',
  channelName: 'release plan',
  guildId: '777',
  guildName: 'My Server',
  categoryName: 'Text Channels',
  parentChannelName: 'general',
  topic: null,
};

export const EXPORTED_AT = new Date('2026-10-06T12:34:56.000Z');

const NO_NAMES = { user: () => undefined, channel: () => undefined, role: () => undefined };

export function context(overrides: { options?: Partial<WriterOptions>; target?: Partial<ExportTarget>; names?: WriterContext['names'] } = {}): WriterContext {
  return {
    target: { ...SERVER_TARGET, ...overrides.target },
    options: { ...OPTIONS, ...overrides.options },
    exportedAt: EXPORTED_AT,
    names: overrides.names ?? NO_NAMES,
  };
}

/** 2026-10-05 12:00:00 UTC (a Monday), plus `offsetMs`. */
export const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

export function message(n: number, content: string, extra: Partial<Message> = {}): Message {
  return {
    id: String(100000000000000000n + BigInt(n)),
    channel_id: '555',
    author: ALICE,
    content,
    timestamp: at(n * SECOND),
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...extra,
  };
}

export function asText(chunks: readonly Chunk[]): string {
  return chunks.map((c) => (typeof c === 'string' ? c : new TextDecoder().decode(c))).join('');
}

export function summaryOf(messages: readonly Message[]): WriterSummary {
  return {
    messageCount: messages.length,
    firstTimestamp: messages[0]?.timestamp ?? null,
    lastTimestamp: messages[messages.length - 1]?.timestamp ?? null,
  };
}

/** The whole file the runner would assemble: start(), one write() per batch, end(). */
export function renderExport(batches: readonly (readonly Message[])[], ctx: WriterContext = context(), summary?: Partial<WriterSummary>): string {
  const writer = htmlFormat.createWriter(ctx);
  const all = batches.flat();
  const chunks: Chunk[] = [...writer.start()];
  for (const batch of batches) chunks.push(...writer.write(batch));
  chunks.push(...writer.end({ ...summaryOf(all), ...summary }));
  return asText(chunks);
}

/** Splits `messages` into consecutive batches of `size`. */
export function batchesOf(messages: readonly Message[], size: number): Message[][] {
  const batches: Message[][] = [];
  for (let from = 0; from < messages.length; from += size) batches.push(messages.slice(from, from + size));
  return batches;
}

/** The newest `size` messages of a channel of the demo world, oldest first. */
export function mockChannelMessages(channelId: string, size = 1000): Promise<Message[]> {
  return collectMessages(createMockClient({ latencyMs: 0 }), channelId, { count: size, fromMs: null, toMs: null, afterId: null });
}

/** The mock "showcase" channel: every message feature at least once, oldest first. */
export function showcaseMessages(): Promise<Message[]> {
  return mockChannelMessages(MOCK_IDS.showcaseChannel);
}

/** A name resolver that knows everybody in `messages`, as the runner's would. */
export function namesFor(messages: readonly Message[]): MessageNameResolver {
  const names = buildNameResolver();
  names.addMessages(messages);
  return names;
}

/** Parses a document or fragment with the DOM of the jsdom environment (the test file has to opt in to it). */
export function parseDocument(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const VOID_ELEMENTS: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<!doctype html>/iy;

/**
 * Strict tag-balance check of a generated document: every `<` starts a tag, every element is closed in order,
 * void elements are never closed, and nothing is left open. Returns the problems found (empty when well-formed).
 * `<style>` holds raw text and is skipped.
 */
export function tagProblems(html: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  let at = html.indexOf('<');
  while (at !== -1) {
    TAG.lastIndex = at;
    const match = TAG.exec(html);
    if (match === null) {
      problems.push(`stray "<" at ${at}: ${html.slice(at, at + 40)}`);
      at = html.indexOf('<', at + 1);
      continue;
    }
    const [whole, closing, rawName, attributes] = match;
    if (rawName !== undefined) {
      const name = rawName.toLowerCase();
      if (closing === '/') {
        if (VOID_ELEMENTS.has(name)) problems.push(`closing tag of void element </${name}> at ${at}`);
        else if (stack[stack.length - 1] === name) stack.pop();
        else problems.push(`</${name}> at ${at} does not match <${stack[stack.length - 1] ?? 'nothing'}>`);
      } else if (!VOID_ELEMENTS.has(name) && !(attributes ?? '').endsWith('/')) {
        stack.push(name);
        if (name === 'style') {
          const end = html.indexOf('</style>', at);
          at = end === -1 ? -1 : end;
          if (at === -1) break;
          continue;
        }
      }
    }
    at = html.indexOf('<', at + whole.length);
  }
  if (stack.length > 0) problems.push(`unclosed: ${stack.join(' > ')}`);
  return problems;
}
