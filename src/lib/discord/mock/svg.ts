import { createRng, hashString } from './prng';

/**
 * Tiny generator of self-contained `data:image/svg+xml;base64,` pictures (gradient + initials / shapes), so the demo
 * has avatars, guild icons and attachments without any network access. Base64 keeps the URIs free of characters that
 * are special in HTML attributes, CSS `url()`, Markdown links and JSON.
 */

const cache = new Map<string, string>();

function memo(key: string, make: () => string): string {
  let value = cache.get(key);
  if (value === undefined) {
    value = make();
    cache.set(key, value);
  }
  return value;
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${base64Utf8(svg)}`;
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Names come from hostile fixtures (`<script>`, `&`, quotes): everything that reaches the SVG text is escaped. */
function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

function hex2(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

/** h in [0, 360), s and l in [0, 1]. Pure arithmetic (no trigonometry). */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return `#${hex2((rgb[0] + m) * 255)}${hex2((rgb[1] + m) * 255)}${hex2((rgb[2] + m) * 255)}`;
}

function palette(seed: string): [string, string] {
  const hue = hashString(`hue:${seed}`) % 360;
  return [hslToHex(hue, 0.65, 0.58), hslToHex((hue + 45) % 360, 0.7, 0.38)];
}

const LETTER = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/** One or two characters representing a name: initials of the first words, or the first letters of a single word. */
function initialsOf(name: string, max = 2): string {
  const words = name.split(/[\s\-_.·|｜/:]+/u).filter((w) => w.length > 0);
  const picks: string[] = [];
  for (const word of words) {
    const letter = Array.from(word).find((ch) => LETTER.test(ch));
    if (letter !== undefined) picks.push(letter);
    if (picks.length >= max) break;
  }
  if (picks.length === 1) {
    const word = words.find((w) => Array.from(w).some((ch) => LETTER.test(ch))) ?? '';
    const letters = Array.from(word).filter((ch) => LETTER.test(ch));
    return letters.slice(0, max).join('').toUpperCase();
  }
  return picks.length > 0 ? picks.join('').toUpperCase() : '?';
}

function badgeSvg(text: string, seed: string, radius: number): string {
  const [from, to] = palette(seed);
  const size = Array.from(text).length > 1 ? 52 : 64;
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128' width='128' height='128'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/></linearGradient></defs>` +
    `<rect width='128' height='128' rx='${radius}' fill='url(#g)'/>` +
    `<text x='64' y='66' font-family='Arial,Helvetica,sans-serif' font-size='${size}' font-weight='700' fill='#fff' text-anchor='middle' dominant-baseline='middle'>${xmlEscape(text)}</text>` +
    `</svg>`
  );
}

/** Square avatar with initials (the UI rounds it). */
export function avatarDataUri(name: string, seed: string): string {
  return memo(`avatar:${seed}:${name}`, () => svgDataUri(badgeSvg(initialsOf(name), seed, 0)));
}

/** Guild / group icon: rounded square with up to three initials. */
export function iconDataUri(name: string, seed: string): string {
  return memo(`icon:${seed}:${name}`, () => svgDataUri(badgeSvg(initialsOf(name, 3), seed, 28)));
}

export interface ImageSpec {
  width: number;
  height: number;
  /** Short caption drawn in the middle. */
  label: string;
  seed: string;
  /** Draw a play button (video thumbnails). */
  play?: boolean;
}

/** Photo-like placeholder: gradient sky, translucent bubbles, dark hills, caption and the pixel size. */
export function imageDataUri(spec: ImageSpec): string {
  const { width: w, height: h, label, seed } = spec;
  return memo(`image:${seed}:${label}:${w}x${h}:${spec.play === true}`, () => {
    const rng = createRng(`image/${seed}/${label}`);
    const [from, to] = palette(seed);
    const unit = Math.min(w, h);
    let shapes = '';
    for (let i = 0; i < 4; i++) {
      const r = rng.int(Math.round(unit / 10), Math.round(unit / 3));
      shapes += `<circle cx='${rng.int(0, w)}' cy='${rng.int(0, h)}' r='${r}' fill='#fff' fill-opacity='0.${rng.int(10, 24)}'/>`;
    }
    const hills = `0,${h} 0,${Math.round(h * 0.7)} ${Math.round(w * 0.25)},${Math.round(h * 0.55)} ${Math.round(w * 0.5)},${Math.round(h * 0.75)} ${Math.round(w * 0.78)},${Math.round(h * 0.5)} ${w},${Math.round(h * 0.68)} ${w},${h}`;
    const fontSize = Math.max(12, Math.round(unit / 11));
    const play = spec.play
      ? `<circle cx='${Math.round(w / 2)}' cy='${Math.round(h / 2)}' r='${Math.round(unit / 7)}' fill='#000' fill-opacity='0.55'/>` +
        `<polygon points='${Math.round(w / 2 - unit / 22)},${Math.round(h / 2 - unit / 14)} ${Math.round(w / 2 - unit / 22)},${Math.round(h / 2 + unit / 14)} ${Math.round(w / 2 + unit / 12)},${Math.round(h / 2)}' fill='#fff'/>`
      : '';
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}' width='${w}' height='${h}'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/></linearGradient></defs>` +
      `<rect width='${w}' height='${h}' fill='url(#g)'/>${shapes}` +
      `<polygon points='${hills}' fill='#000' fill-opacity='0.28'/>` +
      `<text x='${Math.round(w / 2)}' y='${Math.round(h * 0.42)}' font-family='Arial,Helvetica,sans-serif' font-size='${fontSize}' font-weight='700' fill='#fff' text-anchor='middle'>${xmlEscape(label)}</text>` +
      `<text x='${Math.round(w / 2)}' y='${Math.round(h * 0.42 + fontSize * 1.3)}' font-family='Arial,Helvetica,sans-serif' font-size='${Math.max(10, Math.round(fontSize * 0.6))}' fill='#fff' fill-opacity='0.8' text-anchor='middle'>${w} x ${h}</text>` +
      `${play}</svg>`;
    return svgDataUri(svg);
  });
}
