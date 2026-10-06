/**
 * Tiny internal text helpers. Everything the Discord API sends is optional and attacker-controlled, so these
 * accept `unknown` and never throw. Not re-exported from index.ts.
 */

/** Input longer than this is cut before any scanning, which bounds the cost of every pass below. */
const SCAN_LIMIT = 20_000;

const range = (from: number, to: number): string => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;

// C0/C1 controls, line/paragraph separators (U+2028-2029) and bidi override/embedding/isolate characters
// (U+202A-202E, U+2066-2069), which are used for display spoofing. Built from code points so no invisible
// character ever appears in the source.
const CONTROL_OR_BIDI = new RegExp(
  `[\\x00-\\x1f\\x7f-\\x9f${range(0x2028, 0x2029)}${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]`,
  'g',
);

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The string itself when it has visible content, else null. */
export function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function positiveNumber(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n > 0 ? n : null;
}

/** Non-negative integer, else 0. */
export function count(value: unknown): number {
  const n = finiteNumber(value);
  return n !== null && n > 0 ? Math.floor(n) : 0;
}

const SNOWFLAKE = /^\d{1,24}$/;
export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

/** Cut to `max` UTF-16 units including the ellipsis, without splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return max === 1 ? '…' : '';
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** Single-line, control-free, whitespace-collapsed text capped at `max` units. Non-strings become ''. */
export function oneLine(input: unknown, max = Number.POSITIVE_INFINITY): string {
  if (typeof input !== 'string') return '';
  const head = input.length > SCAN_LIMIT ? input.slice(0, SCAN_LIMIT) : input;
  return truncate(head.replace(CONTROL_OR_BIDI, ' ').replace(/\s+/g, ' ').trim(), max);
}
