import { HOUR, MINUTE, SECOND } from './ids';
import { createRng } from './prng';
import type { Rng } from './prng';

export interface TimelineSpec {
  seedKey: string;
  count: number;
  /** Timestamp of the newest message. */
  endMs: number;
  /** Time between the oldest and the newest message (met exactly unless pinned gaps alone exceed it). */
  spanMs: number;
  /** Gap before message `index` in ms; these are never rescaled. */
  pinnedGaps: Readonly<Record<number, number>>;
}

/** Probability that the gap before a message starts a new "session" (hours to days of silence). */
const SESSION_BREAK_P = 0.045;
const MIN_GAP_MS = SECOND;

function sessionGap(rng: Rng): number {
  const r = rng.next();
  if (r < 0.5) return 90 * MINUTE + rng.next() * 4.5 * HOUR;
  if (r < 0.85) return 6 * HOUR + rng.next() * 14 * HOUR;
  return 20 * HOUR + rng.next() * 17 * HOUR;
}

/**
 * Gap inside a conversation: mostly seconds, sometimes a few minutes (still "within 7 minutes"),
 * and 5% of the time longer than 7 minutes so author grouping breaks even for the same author.
 */
function conversationGap(rng: Rng): number {
  const r = rng.next();
  if (r < 0.78) return 2 * SECOND + rng.next() * 73 * SECOND;
  if (r < 0.95) return 90 * SECOND + rng.next() * 270 * SECOND;
  return 7.2 * MINUTE + rng.next() * 33 * MINUTE;
}

/**
 * Ascending message timestamps (ms): messages come in bursts separated by quiet periods. The quiet periods are
 * stretched so that the first message lands exactly `spanMs` before the last one; gaps within a burst keep their
 * natural length. Strictly increasing, at least one second apart.
 */
export function buildTimeline(spec: TimelineSpec): number[] {
  const { count, endMs, spanMs, pinnedGaps } = spec;
  if (count <= 0) return [];

  const rng = createRng(`${spec.seedKey}/time`);
  const gaps: number[] = []; // gaps[i - 1] = distance between message i - 1 and i
  const stretchable: number[] = [];
  const free: number[] = [];
  let pinnedSum = 0;
  let conversationSum = 0;
  let stretchableSum = 0;

  for (let i = 1; i < count; i++) {
    const pinned = pinnedGaps[i];
    if (pinned !== undefined) {
      gaps.push(pinned);
      pinnedSum += pinned;
      continue;
    }
    if (rng.chance(SESSION_BREAK_P)) {
      const gap = sessionGap(rng);
      gaps.push(gap);
      stretchable.push(gaps.length - 1);
      stretchableSum += gap;
    } else {
      const gap = conversationGap(rng);
      gaps.push(gap);
      conversationSum += gap;
    }
    free.push(gaps.length - 1);
  }

  if (stretchable.length > 0) {
    const target = spanMs - pinnedSum - conversationSum;
    if (target >= stretchable.length * 20 * MINUTE) {
      const factor = target / stretchableSum;
      for (const index of stretchable) gaps[index] *= factor;
    }
  } else if (free.length > 0) {
    // Too few messages for a quiet period: spread the whole span over the conversation gaps instead.
    const target = spanMs - pinnedSum;
    if (target >= free.length * 2 * SECOND) {
      const factor = target / conversationSum;
      for (const index of free) gaps[index] *= factor;
    }
  }

  const times = new Array<number>(count);
  times[count - 1] = endMs;
  for (let i = count - 1; i > 0; i--) times[i - 1] = times[i] - Math.max(MIN_GAP_MS, Math.round(gaps[i - 1]));
  return times;
}
