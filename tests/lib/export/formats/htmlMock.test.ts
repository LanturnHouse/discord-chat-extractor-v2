// @vitest-environment jsdom
/**
 * The HTML writer against the demo world of `src/lib/discord/mock` (every message feature at least once, DMs, group DMs, threads).
 *
 * v1 compared the export's markup with the React message view of the app. V2's library has no React and the popup has no message
 * view, so what remains of that safety net is checked here without it: every message of every demo chat renders as one article
 * in well-formed markup, every block kind shows up in the showcase channel, every class the markup uses is styled by the
 * stylesheet shipped inside the file (the markup and message.css / markdown.css stay in sync), and a message is written the same
 * way alone and inside a whole file.
 */
import { describe, expect, it } from 'vitest';
import { context, mockChannelMessages, namesFor, parseDocument, renderExport, showcaseMessages, tagProblems } from './htmlTestKit';
import { MOCK_IDS } from '../../../../src/lib/discord/mock';
import type { Message } from '../../../../src/lib/discord/types';
import { exportStyles } from '../../../../src/lib/export/formats/html/css';
import { createHtmlEnv, renderMessageItem } from '../../../../src/lib/export/formats/html/message';
import { cleanText } from '../../../../src/lib/export/formats/text';

/** The message the file effectively shows: control characters (which the writer removes) are gone. */
function sanitised(message: Message): Message {
  return {
    ...message,
    content: cleanText(message.content),
    message_snapshots: message.message_snapshots?.map((snapshot) => ({ message: { ...snapshot.message, content: cleanText(snapshot.message.content) } })),
  };
}

function fragment(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

function classSet(root: Element): string[] {
  const names = new Set<string>();
  for (const element of Array.from(root.querySelectorAll('[class]'))) for (const name of Array.from(element.classList)) names.add(name);
  return [...names].sort();
}

const CHANNELS = [
  ['showcase', MOCK_IDS.showcaseChannel],
  ['general (newest 600)', MOCK_IDS.generalChannel],
  ['friend DM', MOCK_IDS.dmFriend],
  ['named group DM', MOCK_IDS.groupDmNamed],
  ['large group DM', MOCK_IDS.groupDmLarge],
  ['thread', MOCK_IDS.generalThread],
  ['announcement thread', MOCK_IDS.announcementThread],
] as const;

const SETUPS = [
  ['en', 'UTC'],
  ['ko', 'Asia/Seoul'],
] as const;

describe('the demo world as HTML files', () => {
  it.each(CHANNELS)('%s: one article per message, well-formed, in both languages', async (_name, channelId) => {
    const messages = await mockChannelMessages(channelId, 600);
    expect(messages.length).toBeGreaterThan(0);
    for (const [locale, timeZone] of SETUPS) {
      const html = renderExport([messages], context({ names: namesFor(messages), options: { locale, timeZone } }));
      expect(tagProblems(html), `${locale} ${timeZone}`).toEqual([]);
      const doc = parseDocument(html);
      expect(doc.querySelectorAll('main > article').length).toBe(messages.length);
      expect(doc.querySelectorAll('main > .dce-empty')).toHaveLength(0);
    }
  });

  it('is deterministic: the same messages give the same file', async () => {
    const messages = await showcaseMessages();
    const ctx = context({ names: namesFor(messages) });
    expect(renderExport([messages], ctx)).toBe(renderExport([messages], ctx));
  });

  it('covers every kind of block through the showcase channel', async () => {
    const messages = await showcaseMessages();
    const classes = new Set<string>();
    const env = createHtmlEnv(context({ names: namesFor(messages) }));
    messages.forEach((message, index) => {
      for (const name of classSet(fragment(renderMessageItem(sanitised(message), messages[index - 1], env)))) classes.add(name);
    });
    for (const name of [
      'msg-day-divider',
      'msg--grouped',
      'msg--reply',
      'msg--forward',
      'msg--app',
      'msg--system',
      'msg-reply--deleted',
      'msg-attachment--spoiler',
      'msg-embed--bare',
      'msg-embed--rich',
      'msg-embed__field--col3',
      'msg-poll--closed',
      'msg-reaction--me',
      'msg-system__icon--pin',
      'msg-system__icon--boost',
      'md-spoiler',
      'md-mention',
      'md-emoji-jumbo',
    ]) {
      expect(classes.has(name), name).toBe(true);
    }
    expect(classes.size).toBeGreaterThan(90);
  });

  /**
   * Modifier classes that are written as hooks for whoever edits the file (or for tests) and have no rule of their own. Every other
   * class of the markup is styled; a class that is missing here and in the stylesheet is a typo (or a rule that was lost).
   */
  const HOOKS_WITHOUT_RULE = [
    'msg--app',
    'msg--forward',
    'msg--grouped',
    'msg-attachment--audio',
    'msg-attachment--file',
    'msg-embed--article',
    'msg-embed--gifv',
    'msg-embed--image',
    'msg-embed--link',
    'msg-embed--rich',
    'msg-embed--video',
    'msg-embed__field--inline',
    'msg-embed__footer-sep',
    'msg-poll--closed',
    'msg-sticker',
    'msg-system__icon--neutral',
    'msg-system__icon--pin',
  ];

  it('styles every class that the markup of the demo world uses, except the documented hooks', async () => {
    const css = exportStyles();
    const styled = new Set<string>();
    for (const match of css.matchAll(/\.([A-Za-z_][\w-]*)/g)) styled.add(match[1]!);
    const used = new Set<string>();
    for (const [, channelId] of CHANNELS) {
      const messages = await mockChannelMessages(channelId, 600);
      const env = createHtmlEnv(context({ names: namesFor(messages) }));
      messages.forEach((message, index) => {
        for (const name of classSet(fragment(renderMessageItem(sanitised(message), messages[index - 1], env)))) used.add(name);
      });
    }
    const page = parseDocument(renderExport([await showcaseMessages()], context()));
    for (const name of classSet(page.body)) used.add(name);
    expect([...used].filter((name) => !styled.has(name)).sort()).toEqual(HOOKS_WITHOUT_RULE);
  });

  it('writes the same markup for a message whether it is rendered alone or as part of the whole file', async () => {
    const messages = await showcaseMessages();
    const ctx = context({ names: namesFor(messages) });
    const env = createHtmlEnv(ctx);
    const whole = renderExport([messages], ctx);
    const items = messages.map((message, index) => renderMessageItem(message, messages[index - 1], env));
    expect(whole).toContain(items.join('\n'));
    expect(parseDocument(whole).querySelectorAll('main > article').length).toBe(messages.length);
  });
});
