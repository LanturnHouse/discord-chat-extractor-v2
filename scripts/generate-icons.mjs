// Draws the extension icons (16/32/48/128 px) into public/icons/ without any image dependency:  node scripts/generate-icons.mjs
// Motif (deliberately unlike v1's speech bubble): blurple rounded square, white download arrow dropping into a tray,
// and a small yellow "2" badge in the corner (v2). Every pixel is supersampled (SS x SS) so edges are anti-aliased.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const BRAND = [0x58, 0x65, 0xf2]; // Discord blurple #5865F2
const WHITE = [0xff, 0xff, 0xff];
const BADGE = [0xfe, 0xe7, 0x5c]; // Discord yellow
const INK = [0x23, 0x27, 0x2a]; // the "2" on the badge
export const SIZES = [16, 32, 48, 128];
const SS = 8;
const CORNER_RADIUS = 28;

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ---- geometry, in a 128 x 128 design space -------------------------------------------------

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(x - (ax + t * abx), y - (ay + t * aby));
}

/** The numeral "2" as a polyline in a unit box (y down): an arc over the top, a diagonal, a base line. */
const TWO = (() => {
  const points = [];
  const [cx, cy, radius] = [0, -0.36, 0.56];
  for (let deg = 195; deg >= -40; deg -= 12) {
    const a = (deg * Math.PI) / 180;
    points.push([cx + radius * Math.cos(a), cy - radius * Math.sin(a)]);
  }
  points.push([-0.62, 0.64], [0.66, 0.64]);
  return points;
})();

function inTwo(x, y, badge) {
  const scale = badge.r * 0.72; // glyph units -> design units
  const px = (x - badge.cx) / scale;
  const py = (y - badge.cy + badge.r * 0.03) / scale; // the glyph sits a hair low: optical centring in the circle
  for (let i = 0; i + 1 < TWO.length; i++) {
    if (distanceToSegment(px, py, TWO[i], TWO[i + 1]) <= badge.stroke) return true; // stroke = half the line width
  }
  return false;
}

// 16 and 32 px share one pixel-aligned design (every edge on a multiple of 8 design units = whole pixels at 16 px, so the arrow
// and tray stay crisp) with chunkier strokes; the numeral on the badge is only drawn from 32 px up, where it is legible.
function shapesFor(size) {
  if (size <= 32) {
    return {
      shaft: { x0: 56, x1: 72, y0: 24, y1: 60 },
      head: { halfWidth: 24, top: 56, tip: 88 },
      tray: { x0: 16, x1: 112, top: 72, bottom: 112, thickness: 16, radius: 4 },
      badge: { cx: 101, cy: 27, r: size <= 16 ? 21 : 25, numeral: size >= 32, stroke: 0.26 },
    };
  }
  return {
    shaft: { x0: 53, x1: 67, y0: 20, y1: 64 },
    head: { halfWidth: 26, top: 56, tip: 86 },
    tray: { x0: 22, x1: 98, top: 78, bottom: 106, thickness: 12, radius: 5 },
    badge: { cx: 98, cy: 30, r: 24, numeral: true, stroke: 0.2 },
  };
}

function colorAt(x, y, shapes) {
  if (!inRoundRect(x, y, 0, 0, 128, 128, CORNER_RADIUS)) return null;
  const { shaft, head, tray, badge } = shapes;

  const bx = x - badge.cx;
  const by = y - badge.cy;
  if (bx * bx + by * by <= badge.r * badge.r) return badge.numeral && inTwo(x, y, badge) ? INK : BADGE;

  const cx = (shaft.x0 + shaft.x1) / 2;
  const inShaft = x >= shaft.x0 && x <= shaft.x1 && y >= shaft.y0 && y <= head.top + 2;
  const inHead = inTriangle(x, y, [cx - head.halfWidth, head.top], [cx + head.halfWidth, head.top], [cx, head.tip]);
  const inTray =
    inRoundRect(x, y, tray.x0, tray.top, tray.x0 + tray.thickness, tray.bottom, tray.radius) || // left wall
    inRoundRect(x, y, tray.x1 - tray.thickness, tray.top, tray.x1, tray.bottom, tray.radius) || // right wall
    inRoundRect(x, y, tray.x0, tray.bottom - tray.thickness, tray.x1, tray.bottom, tray.radius); // floor
  return inShaft || inHead || inTray ? WHITE : BRAND;
}

// ---- rasteriser ----------------------------------------------------------------------------

/** RGBA pixels of the `size` x `size` icon. */
export function render(size) {
  const shapes = shapesFor(size);
  const scale = 128 / size;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          const c = colorAt(x, y, shapes);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            covered++;
          }
        }
      }
      const o = (py * size + px) * 4;
      if (covered > 0) {
        pixels[o] = Math.round(r / covered);
        pixels[o + 1] = Math.round(g / covered);
        pixels[o + 2] = Math.round(b / covered);
        pixels[o + 3] = Math.round((covered / (SS * SS)) * 255);
      }
    }
  }
  return pixels;
}

// ---- minimal PNG encoder -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A PNG file (8-bit RGBA, no interlacing) from `render()` output. */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const file = resolve(OUT_DIR, `icon${size}.png`);
    writeFileSync(file, encodePng(size, render(size)));
    console.log(`wrote ${file}`);
  }
}
