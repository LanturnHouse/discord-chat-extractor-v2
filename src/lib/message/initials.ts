/**
 * What stands in for a missing picture: the letters of a server icon, the initial of an avatar and the colour slot of its
 * circle. Pure and shared, so a name gets the same placeholder in the app and in every export.
 */

/** Most glyphs shown in a server icon that has no image. */
export const MAX_ACRONYM_GLYPHS = 4;

/** Number of colours of the fallback circle (the same palette size as Discord's default avatars). */
const TONES = 6;

// One user-perceived character at a time, so a flag, a family emoji or a letter with combining marks is never cut in half.
// Engines without Intl.Segmenter fall back to code points (still surrogate-safe, just less exact for joined emoji).
const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Letters, digits, emoji and flags. Punctuation-only "words" such as "-" or "&" do not count as a word of the name. */
const MEANINGFUL = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

export function glyphsOf(text: string): string[] {
  return SEGMENTER === null ? Array.from(text) : Array.from(SEGMENTER.segment(text), (part) => part.segment);
}

/**
 * The text of a server icon without an image: the first character of each word, at most four ("Open Source Garage" -> "OSG",
 * "개발자 라운지" -> "개라"). Works for emoji and CJK names; a name without any letter, digit or emoji falls back to its first
 * visible character, an empty name to "?".
 */
export function acronymOf(name: string): string {
  const picked: string[] = [];
  for (const word of name.split(/\s+/)) {
    const glyph = glyphsOf(word).find((candidate) => MEANINGFUL.test(candidate));
    if (glyph === undefined) continue;
    picked.push(glyph);
    if (picked.length === MAX_ACRONYM_GLYPHS) break;
  }
  if (picked.length > 0) return picked.join('');
  return glyphsOf(name.trim())[0] ?? '?';
}

/** The first visible character of a name, upper-cased ("?" for an empty name): the letter of an avatar without an image. */
export function initialOf(name: string): string {
  const first = glyphsOf(name.trim())[0];
  return first === undefined ? '?' : first.toUpperCase();
}

/** Colour slot (0 .. 5) of an avatar circle: the same for the same id, and a non-string id still gets slot 0. */
export function toneOf(id: unknown): number {
  const text = typeof id === 'string' ? id : '';
  let sum = 0;
  for (let i = 0; i < text.length; i += 1) sum = (sum + text.charCodeAt(i)) % TONES;
  return sum;
}
