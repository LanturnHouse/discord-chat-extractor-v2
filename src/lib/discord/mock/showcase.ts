import { DAY, HOUR, MINUTE, SECOND } from './ids';
import { KINDS } from './kinds';
import type { KindName, ScriptEntry } from './types';

/** People that write in the showcase channel, most active first. Chosen for their awkward display names. */
export const SHOWCASE_AUTHORS: readonly string[] = ['minjun', 'alex', 'mina', 'ahmad', 'muller', 'legacy', 'long', 'me', 'seoyeon', 'sam', 'pizza', 'evil'];

/** Kinds that appear once per variant after the hand-written opening. System kinds that need a DM / group DM are left out. */
const EXHAUSTIVE: readonly KindName[] = [
  'long',
  'multilingual',
  'markdown',
  'mention',
  'emoji',
  'timestamp',
  'link',
  'hostile',
  'attachment',
  'embed',
  'sticker',
  'poll',
  'forward',
  'bot',
  'webhook',
  'reply',
  'reply-deleted',
  'sys-join',
  'sys-pin',
  'sys-boost',
  'sys-thread',
];

/**
 * The feature tour: a deterministic list that contains every message kind and variant at least once,
 * preceded by a hand-timed opening that exercises author grouping around the 7-minute threshold and day boundaries.
 */
export function buildShowcaseScript(): ScriptEntry[] {
  const script: ScriptEntry[] = [];
  const add = (kind: KindName, extra: Partial<ScriptEntry> = {}): void => {
    script.push({ kind, ...extra });
  };

  // Author grouping. Gaps are measured to the previous message; the 4th message is 6m59s after its predecessor
  // but more than 7 minutes after the first message of its run.
  add('text', { author: 'minjun' });
  add('short', { author: 'minjun', gapBeforeMs: 20 * SECOND });
  add('text', { author: 'minjun', gapBeforeMs: 45 * SECOND });
  add('text', { author: 'minjun', gapBeforeMs: 6 * MINUTE + 59 * SECOND });
  add('text', { author: 'alex', gapBeforeMs: 30 * SECOND });
  add('short', { author: 'minjun', gapBeforeMs: 40 * SECOND });
  add('text', { author: 'minjun', gapBeforeMs: 7 * MINUTE + SECOND }); // just beyond 7 minutes: new group
  add('short', { author: 'minjun', gapBeforeMs: 59 * SECOND });
  add('text', { author: 'alex', gapBeforeMs: 26 * HOUR }); // next day
  add('short', { author: 'alex', gapBeforeMs: 3 * DAY });

  let counter = 0;
  for (const kind of EXHAUSTIVE) {
    for (let variant = 0; variant < KINDS[kind].variants; variant++) {
      counter++;
      const extra: Partial<ScriptEntry> = { variant, reactions: counter % 4 === 0, edited: counter % 7 === 3 };
      if (kind === 'markdown' && variant === 0) extra.gapBeforeMs = 96 * DAY; // multi-month silence
      if (kind === 'attachment' && variant === 0) extra.gapBeforeMs = 20 * HOUR;
      add(kind, extra);
    }
  }
  return script;
}
