import type { User } from '../types';
import { person } from './cast';
import { KINDS } from './kinds';
import { createRng } from './prng';
import type { Rng } from './prng';
import type { Flavour, KindName, MessageProfile } from './types';

export interface PlanEntry {
  kind: KindName;
  variant: number;
  author: User;
  /** Index (into the same plan) of the message a reply answers / a pin message points at. */
  target?: number;
  edited: boolean;
  reactions: boolean;
}

type Weights = readonly (readonly [KindName, number])[];

const GENERAL: Weights = [
  ['text', 40],
  ['short', 17],
  ['reply', 9],
  ['reply-deleted', 0.6],
  ['markdown', 4],
  ['mention', 4],
  ['emoji', 3],
  ['link', 3],
  ['timestamp', 0.5],
  ['attachment', 5],
  ['embed', 2],
  ['sticker', 1],
  ['long', 1.2],
  ['multilingual', 1],
  ['bot', 1],
  ['webhook', 0.5],
  ['poll', 0.4],
  ['forward', 0.4],
  ['hostile', 0.25],
  ['sys-join', 0.8],
  ['sys-pin', 0.3],
  ['sys-boost', 0.2],
  ['sys-thread', 0.15],
];

const DM: Weights = [
  ['text', 45],
  ['short', 20],
  ['emoji', 6],
  ['attachment', 6],
  ['sticker', 3],
  ['link', 4],
  ['reply', 7],
  ['reply-deleted', 0.5],
  ['sys-call', 3],
  ['forward', 1.5],
  ['poll', 0.2],
  ['markdown', 1],
  ['embed', 1],
  ['multilingual', 1],
  ['timestamp', 1],
];

function derive(base: Weights, overrides: Partial<Record<KindName, number>>): Weights {
  const merged = new Map<KindName, number>(base);
  for (const [kind, weight] of Object.entries(overrides) as [KindName, number][]) merged.set(kind, weight);
  return [...merged].filter(([, weight]) => weight > 0);
}

const WEIGHTS: Record<Exclude<Flavour, 'showcase'>, Weights> = {
  general: GENERAL,
  plain: [['text', 60], ['short', 25], ['reply', 6], ['attachment', 3], ['emoji', 2], ['link', 2], ['markdown', 2]],
  chatty: derive(GENERAL, { short: 26, reply: 12, emoji: 5, 'sys-join': 0.2 }),
  announce: [['markdown', 30], ['text', 15], ['embed', 20], ['mention', 8], ['webhook', 10], ['link', 5], ['attachment', 5], ['long', 5], ['poll', 2]],
  code: [['markdown', 25], ['text', 30], ['link', 8], ['attachment', 8], ['reply', 12], ['short', 8], ['long', 3], ['embed', 3], ['bot', 2]],
  bots: [['bot', 40], ['webhook', 25], ['text', 15], ['markdown', 5], ['embed', 10], ['poll', 2], ['reply', 3]],
  memes: [['attachment', 45], ['embed', 10], ['short', 15], ['text', 10], ['reply', 8], ['emoji', 6], ['sticker', 4], ['link', 4]],
  music: [['link', 40], ['embed', 20], ['text', 20], ['short', 10], ['reply', 5], ['attachment', 5]],
  photos: [['attachment', 55], ['text', 15], ['short', 10], ['reply', 5], ['emoji', 5], ['embed', 3]],
  welcome: [['sys-join', 40], ['text', 25], ['short', 10], ['reply', 5], ['sys-boost', 5], ['markdown', 5], ['emoji', 5]],
  intro: [['text', 40], ['long', 15], ['multilingual', 8], ['sys-join', 15], ['emoji', 6], ['attachment', 5], ['reply', 8]],
  voicechat: [['text', 50], ['short', 30], ['link', 5], ['reply', 5]],
  thread: [['text', 50], ['short', 20], ['reply', 10], ['attachment', 4], ['markdown', 6], ['link', 3], ['emoji', 2]],
  dm: DM,
  'group-dm': derive(DM, { mention: 2, 'sys-recipient-add': 0.7, 'sys-recipient-remove': 0.4, 'sys-name-change': 0.4, 'sys-icon-change': 0.3 }),
};

const REACTION_CHANCE: Partial<Record<Flavour, number>> = { memes: 0.4, announce: 0.3, dm: 0.08, 'group-dm': 0.1, bots: 0.05 };
const EDIT_CHANCE = 0.06;
const AUTHOR_CONTINUITY = 0.45;

/** Looks at the previous 30 messages for something a reply / pin can point at (never system messages). */
function pickTarget(entries: readonly PlanEntry[], rng: Rng): number | undefined {
  const candidates: number[] = [];
  for (let j = Math.max(0, entries.length - 30); j < entries.length; j++) {
    if (!KINDS[entries[j].kind].system) candidates.push(j);
  }
  return candidates.length > 0 ? rng.pick(candidates) : undefined;
}

/**
 * Decides kind, variant, author and overlays (edit, reactions) of every message of a channel.
 * Uses only the profile + its own seeded stream, so the plan is stable for a given channel.
 */
export function planChannel(profile: MessageProfile): PlanEntry[] {
  const rng = createRng(`${profile.seedKey}/plan`);
  const authorWeights = profile.authors.map((_, i) => [i, Math.max(1, 16 - 2 * i)] as const);
  const weights = profile.flavour === 'showcase' ? [] : WEIGHTS[profile.flavour];
  const reactionChance = REACTION_CHANCE[profile.flavour] ?? 0.13;
  const entries: PlanEntry[] = [];
  let previousAuthor: User | undefined;

  for (let i = 0; i < profile.count; i++) {
    const scripted = profile.script?.[i];
    let kind: KindName = scripted ? scripted.kind : i === 0 && profile.firstKind ? profile.firstKind : rng.weighted(weights);
    let variant = scripted ? (scripted.variant ?? 0) : rng.int(0, (KINDS[kind].randomVariants ?? KINDS[kind].variants) - 1);

    let target: number | undefined;
    if (kind === 'reply' || kind === 'sys-pin') {
      target = pickTarget(entries, rng);
      if (target === undefined) kind = 'text';
    } else if (kind === 'sys-thread' && profile.threads.length === 0) {
      kind = 'text';
    } else if ((kind === 'sys-call' || kind === 'sys-recipient-add' || kind === 'sys-recipient-remove') && profile.authors.length < 2) {
      kind = 'text';
    }
    if (kind === 'text' && !scripted) variant = 0;
    variant %= KINDS[kind].variants;

    let author: User;
    if (scripted?.author) author = person(scripted.author);
    else if (previousAuthor && rng.chance(AUTHOR_CONTINUITY)) author = previousAuthor;
    else author = profile.authors[rng.weighted(authorWeights)];
    previousAuthor = author;

    const system = KINDS[kind].system === true;
    entries.push({
      kind,
      variant,
      author,
      ...(target !== undefined && kind !== 'text' ? { target } : {}),
      edited: system ? false : scripted ? scripted.edited === true : rng.chance(EDIT_CHANCE),
      reactions: system ? false : scripted ? scripted.reactions === true : rng.chance(reactionChance),
    });
  }
  return entries;
}
