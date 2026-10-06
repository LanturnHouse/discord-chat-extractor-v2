// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  CHECK_PATH,
  DOWNLOAD_PATH,
  REMOVE_PATH,
  TOAST_ICON_PATHS,
  createIconSvg,
  createToastIcon,
  currentIcon,
  setIcon,
} from '@/content/inject/icons';

interface Point {
  x: number;
  y: number;
}

/** Absolute points of every subpath of a path made of M m L l H h V v Z (all the icons use nothing else), and whether it closes. */
function subpaths(d: string): { points: Point[]; closed: boolean }[] {
  const tokens = d.match(/[MmLlHhVvZz]|-?\d*\.?\d+/g) ?? [];
  expect(tokens.join('').length, `unparsed characters in ${d}`).toBeGreaterThan(0);
  const result: { points: Point[]; closed: boolean }[] = [];
  let current: { points: Point[]; closed: boolean } | null = null;
  let x = 0;
  let y = 0;
  let command = '';
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/[A-Za-z]/.test(token)) {
      command = token;
      i++;
      if (command === 'Z' || command === 'z') {
        if (current) {
          current.closed = true;
          x = current.points[0]!.x;
          y = current.points[0]!.y;
          current = null;
        }
        continue;
      }
    }
    switch (command) {
      case 'M':
      case 'm': {
        const nx = num();
        const ny = num();
        x = command === 'm' ? x + nx : nx;
        y = command === 'm' ? y + ny : ny;
        current = { points: [{ x, y }], closed: false };
        result.push(current);
        command = command === 'm' ? 'l' : 'L'; // further pairs are line-tos
        break;
      }
      case 'L':
      case 'l': {
        const nx = num();
        const ny = num();
        x = command === 'l' ? x + nx : nx;
        y = command === 'l' ? y + ny : ny;
        current!.points.push({ x, y });
        break;
      }
      case 'H':
      case 'h': {
        const nx = num();
        x = command === 'h' ? x + nx : nx;
        current!.points.push({ x, y });
        break;
      }
      case 'V':
      case 'v': {
        const ny = num();
        y = command === 'v' ? y + ny : ny;
        current!.points.push({ x, y });
        break;
      }
      default:
        throw new Error(`unexpected command ${command} in ${d}`);
    }
  }
  return result;
}

const area = (points: Point[]): number => {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
};

const bounds = (paths: { points: Point[] }[]) => {
  const all = paths.flatMap((p) => p.points);
  return {
    minX: Math.min(...all.map((p) => p.x)),
    maxX: Math.max(...all.map((p) => p.x)),
    minY: Math.min(...all.map((p) => p.y)),
    maxY: Math.max(...all.map((p) => p.y)),
  };
};

describe('the icons are well-formed shapes inside the 24x24 viewBox', () => {
  const icons: [string, string][] = [
    ['download', DOWNLOAD_PATH],
    ['check', CHECK_PATH],
    ['remove (the cross)', REMOVE_PATH],
    ['toast info', TOAST_ICON_PATHS.info],
    ['toast error', TOAST_ICON_PATHS.error],
  ];

  it.each(icons)('%s: every subpath is closed, has area, and stays inside the box', (_name, d) => {
    const paths = subpaths(d);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.closed).toBe(true);
      expect(path.points.length).toBeGreaterThanOrEqual(4);
      expect(area(path.points)).toBeGreaterThan(1);
    }
    const b = bounds(paths);
    expect(b.minX).toBeGreaterThanOrEqual(0);
    expect(b.minY).toBeGreaterThanOrEqual(0);
    expect(b.maxX).toBeLessThanOrEqual(24);
    expect(b.maxY).toBeLessThanOrEqual(24);
  });

  it('the three button glyphs are centred (a 16px icon next to Discord`s own must not look off to one side)', () => {
    for (const d of [DOWNLOAD_PATH, CHECK_PATH, REMOVE_PATH]) {
      const b = bounds(subpaths(d));
      expect(Math.abs((b.minX + b.maxX) / 2 - 12)).toBeLessThan(1);
      expect(Math.abs((b.minY + b.maxY) / 2 - 12)).toBeLessThan(1);
      expect(b.maxX - b.minX).toBeGreaterThan(12); // big enough to read at 16px
    }
  });

  it('the check mark has the stroke thickness of a check (an arm 2.4 wide)', () => {
    const [mark] = subpaths(CHECK_PATH);
    expect(area(mark!.points)).toBeGreaterThan(20);
    expect(area(mark!.points)).toBeLessThan(60);
  });

  it('the cross is ONE closed shape with straight segments only (an X: 12 corners), symmetric about the centre of the box', () => {
    expect(REMOVE_PATH).not.toMatch(/[CcSsQqTtAa]/); // no curves
    const shapes = subpaths(REMOVE_PATH);
    expect(shapes).toHaveLength(1);
    const [cross] = shapes;
    expect(cross!.points).toHaveLength(12);
    const key = (p: Point): string => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    const corners = new Set(cross!.points.map(key));
    expect(corners.size).toBe(12); // no corner twice
    for (const p of cross!.points) {
      // mirrored left-right, up-down and along the diagonal: the four arms are equal, so it reads as an X and not as a "t"
      expect(corners.has(key({ x: 24 - p.x, y: p.y }))).toBe(true);
      expect(corners.has(key({ x: p.x, y: 24 - p.y }))).toBe(true);
      expect(corners.has(key({ x: p.y, y: p.x }))).toBe(true);
    }
    // arms about as heavy as the check mark's (not a hairline at 16px): a little thinner is fine, a cross is two strokes
    expect(area(cross!.points)).toBeGreaterThan(30);
    expect(area(cross!.points)).toBeLessThan(80);
  });

  it('the cross is about the size of the check mark, so the swap on hover does not make the icon jump', () => {
    const check = bounds(subpaths(CHECK_PATH));
    const cross = bounds(subpaths(REMOVE_PATH));
    expect(Math.abs(cross.maxX - cross.minX - (check.maxX - check.minX))).toBeLessThan(3);
    expect(Math.abs(cross.maxY - cross.minY - (check.maxY - check.minY))).toBeLessThan(3);
  });

  it('the download arrow is an arrow over a tray: two shapes, the tray below the arrow head', () => {
    const [arrow, tray] = subpaths(DOWNLOAD_PATH) as [ReturnType<typeof subpaths>[number], ReturnType<typeof subpaths>[number]];
    expect(bounds([tray]).minY).toBeGreaterThan(bounds([arrow]).maxY);
  });
});

describe('the svg of a button', () => {
  it('has the contract of PLAN §7.1: 24x24 viewBox, currentColor, hidden from assistive technology', () => {
    const svg = createIconSvg(document, 'download', 16);
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    // Two glyphs, nothing else: the state glyph (first) and the cross for hovering a checked button (second).
    expect(Array.from(svg.children).map((el) => el.tagName)).toEqual(['path', 'path']);
  });

  it('holds both glyphs: the state glyph first (what `querySelector("path")` finds), the cross second, each marked', () => {
    const svg = createIconSvg(document, 'download', 16);
    const [state, remove] = Array.from(svg.querySelectorAll('path'));
    expect(state!.getAttribute('data-dce-glyph')).toBe('state');
    expect(state!.getAttribute('d')).toBe(DOWNLOAD_PATH);
    expect(remove!.getAttribute('data-dce-glyph')).toBe('remove');
    expect(remove!.getAttribute('d')).toBe(REMOVE_PATH);
    expect(svg.querySelector('path')).toBe(state); // first in document order
    expect(REMOVE_PATH).not.toBe(CHECK_PATH);
    expect(REMOVE_PATH).not.toBe(DOWNLOAD_PATH);
    // Nothing on the glyphs hides them: showing / hiding the cross is the stylesheet's business alone.
    for (const glyph of [state!, remove!]) {
      expect(glyph.hasAttribute('style')).toBe(false);
      expect(glyph.hasAttribute('display')).toBe(false);
      expect(glyph.hasAttribute('class')).toBe(false);
    }
    // The marker is not `data-dce` itself, so nothing that looks for our nodes ([data-dce]) finds the glyphs.
    expect(svg.querySelectorAll('[data-dce]')).toHaveLength(0);
  });

  it('both glyphs exist from the start, whatever the state', () => {
    for (const name of ['download', 'check'] as const) {
      const svg = createIconSvg(document, name, 20);
      expect(svg.querySelectorAll('path[data-dce-glyph="state"]')).toHaveLength(1);
      expect(svg.querySelectorAll('path[data-dce-glyph="remove"]')).toHaveLength(1);
      expect(svg.querySelector('path[data-dce-glyph="remove"]')!.getAttribute('d')).toBe(REMOVE_PATH);
    }
  });

  it('switching the icon swaps the state path only: the cross is never touched, and `currentIcon` speaks about the state', () => {
    const svg = createIconSvg(document, 'download', 16);
    const path = svg.querySelector('path')!;
    const remove = svg.querySelector('path[data-dce-glyph="remove"]')!;
    expect(currentIcon(svg)).toBe('download');
    setIcon(svg, 'check');
    expect(currentIcon(svg)).toBe('check');
    expect(svg.querySelector('path')).toBe(path); // the same node: nothing is rebuilt
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(remove.getAttribute('d')).toBe(REMOVE_PATH);
    setIcon(svg, 'download');
    expect(currentIcon(svg)).toBe('download');
    expect(remove.getAttribute('d')).toBe(REMOVE_PATH);
  });

  it('`currentIcon` never reports the cross (it is a hover effect of the checked state, not a state)', () => {
    const svg = createIconSvg(document, 'check', 16);
    expect(currentIcon(svg)).toBe('check');
    // Even an svg whose only path is the cross is "no known state", not a third icon.
    svg.querySelector('path:not([data-dce-glyph="remove"])')!.remove();
    expect(currentIcon(svg)).toBeNull();
    setIcon(svg, 'download'); // nothing to write to: no crash, and the cross stays what it is
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(REMOVE_PATH);
  });

  it('toast icons are small svgs of the same kind', () => {
    for (const name of ['success', 'info', 'error'] as const) {
      const svg = createToastIcon(document, name);
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('fill')).toBe('currentColor');
      expect(svg.getAttribute('d') ?? svg.querySelector('path')?.getAttribute('d')).toBeTruthy();
    }
  });
});
