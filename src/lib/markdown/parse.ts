import type { MdNode } from './types';
import { safeUrl } from './url';

/**
 * Discord-flavoured markdown parser.
 *
 * The input is attacker-controlled, so every loop here is amortised O(n):
 *  - block level: one pass over the lines; the only look-ahead (fence closers) is cached or consumed by the construct;
 *  - inline level: one left-to-right pass with delimiter "frames" (no re-scanning, no recursion). Matching a closer
 *    splices the content of the opener out of the output list, so each node is moved at most MAX_DEPTH times;
 *  - the only unbounded scans (link destinations) draw from a per-call budget proportional to the input size;
 *  - nesting is capped at MAX_DEPTH (inline) / MAX_LIST_DEPTH (lists); a quote cannot nest inside a quote.
 * Anything that does not form a valid construct stays literal text.
 */

/** Maximum nesting of inline formatting nodes (strong > em > link ...). Deeper markers stay literal. */
export const MAX_DEPTH = 20;
/** Maximum list nesting; deeper indentation is flattened into the deepest level. */
const MAX_LIST_DEPTH = 20;
/** Discord shows "jumbo" emoji only for messages with at most this many emoji. */
export const JUMBO_EMOJI_MAX = 27;

type ListNode = Extract<MdNode, { type: 'list' }>;
type TimestampNode = Extract<MdNode, { type: 'timestamp' }>;
type EmphasisType = 'strong' | 'em' | 'underline' | 'strike' | 'spoiler';
type DelimiterKey = '*' | '_' | '~' | '|' | '[';

// ---------------------------------------------------------------------------------------------------------------------
// character helpers
// ---------------------------------------------------------------------------------------------------------------------

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
/** ASCII [A-Za-z0-9] — Discord's `\b` is ASCII-only, so Korean letters next to `_` are word boundaries. */
const isAsciiAlnum = (c: number): boolean => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number): boolean =>
  c === 32 ||
  (c >= 9 && c <= 13) ||
  c === 160 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;
const isLangChar = (c: number): boolean => isAsciiAlnum(c) || c === 95 || c === 43 || c === 45 || c === 46 || c === 35;

// ---------------------------------------------------------------------------------------------------------------------
// block level
// ---------------------------------------------------------------------------------------------------------------------

interface ListFrame {
  indent: number;
  ordered: boolean;
  node: ListNode;
  /** Array the list node lives in (document root, or the item it is nested in) - siblings go there too. */
  container: MdNode[];
}

interface Fence {
  lang: string | null;
  text: string;
  end: number;
}

/**
 * Discord fence: ``` [lang\n] content ```. The language is only recognised when it is followed by a newline,
 * leading newlines / trailing whitespace are dropped, empty bodies are not fences.
 * `fi` is the index of the opening backticks; `lastFence` the index of the last "```" in the source.
 */
function parseFence(src: string, fi: number, lastFence: number): Fence | null {
  if (lastFence < fi + 3) return null;
  const close = src.indexOf('```', fi + 3);
  if (close === -1) return null;
  let start = fi + 3;
  let j = start;
  while (j < close && isLangChar(src.charCodeAt(j))) j++;
  let lang: string | null = null;
  if (j > start && j < close && src.charCodeAt(j) === 10) {
    lang = src.slice(start, j);
    start = j + 1;
  }
  while (start < close && src.charCodeAt(start) === 10) start++;
  let end = close;
  while (end > start && (src.charCodeAt(end - 1) === 10 || src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9)) end--;
  let hasContent = false;
  for (let k = start; k < end; k++) {
    if (!isSpace(src.charCodeAt(k))) {
      hasContent = true;
      break;
    }
  }
  if (!hasContent) return null;
  return { lang, text: src.slice(start, end), end: close + 3 };
}

interface ListMarker {
  ordered: boolean;
  num: number;
  contentStart: number;
}

function matchListMarker(src: string, p: number, eol: number): ListMarker | null {
  const c = src.charCodeAt(p);
  let ordered = false;
  let num = 1;
  let q: number;
  if (c === 45 || c === 42) {
    if (src.charCodeAt(p + 1) !== 32) return null;
    q = p + 2;
  } else if (isDigit(c)) {
    let d = p;
    while (d < eol && d - p < 10 && isDigit(src.charCodeAt(d))) d++;
    if (d - p > 9 || src.charCodeAt(d) !== 46 || src.charCodeAt(d + 1) !== 32) return null;
    ordered = true;
    num = Number(src.slice(p, d));
    q = d + 2;
  } else {
    return null;
  }
  while (q < eol && src.charCodeAt(q) === 32) q++;
  if (q >= eol) return null; // an empty item is plain text
  return { ordered, num, contentStart: q };
}

class BlockParser {
  private readonly out: MdNode[] = [];
  private pos = 0;
  /** False for the remainder of a line after a mid-line code block: block markers are not recognised there. */
  private atLineStart = true;
  private paraStart = -1;
  private paraEnd = -1;
  private lists: ListFrame[] = [];
  private nextFence: number;
  private readonly lastFence: number;

  constructor(
    private readonly src: string,
    private readonly inQuote: boolean,
  ) {
    this.nextFence = src.indexOf('```');
    this.lastFence = src.lastIndexOf('```');
  }

  parse(): MdNode[] {
    const n = this.src.length;
    while (this.pos < n) {
      let eol = this.src.indexOf('\n', this.pos);
      if (eol === -1) eol = n;
      if (this.atLineStart && this.blockLine(eol)) continue;
      this.plainLine(eol);
    }
    this.flushParagraph();
    return this.out;
  }

  private flushParagraph(): void {
    if (this.paraStart >= 0 && this.paraEnd > this.paraStart) {
      for (const node of parseInline(this.src.slice(this.paraStart, this.paraEnd))) this.out.push(node);
    }
    this.paraStart = -1;
  }

  /** Quote / heading / subtext / list at the start of a line. Returns false when the line is plain text. */
  private blockLine(eol: number): boolean {
    const { src } = this;
    let p = this.pos;
    while (p < eol && src.charCodeAt(p) === 32) p++;
    const indent = p - this.pos;
    const c = src.charCodeAt(p);

    if (c === 62 && !this.inQuote) {
      if (src.startsWith('>>> ', p)) {
        this.closeLists();
        this.flushParagraph();
        this.out.push({ type: 'blockQuote', children: new BlockParser(src.slice(p + 4), true).parse() });
        this.pos = src.length;
        return true;
      }
      if (src.charCodeAt(p + 1) === 32) {
        this.closeLists();
        this.flushParagraph();
        this.quote(p, eol);
        return true;
      }
      return false;
    }

    if (c === 35) {
      let h = 0;
      while (h < 4 && src.charCodeAt(p + h) === 35) h++;
      if (h <= 3 && src.charCodeAt(p + h) === 32) {
        const content = src.slice(p + h + 1, eol).trim();
        if (content) {
          this.closeLists();
          this.flushParagraph();
          this.out.push({ type: 'heading', level: h as 1 | 2 | 3, children: parseInline(content) });
          this.pos = eol + 1;
          return true;
        }
      }
      return false;
    }

    if (c === 45 && src.charCodeAt(p + 1) === 35 && src.charCodeAt(p + 2) === 32) {
      const content = src.slice(p + 3, eol).trim();
      if (content) {
        this.closeLists();
        this.flushParagraph();
        this.out.push({ type: 'subtext', children: parseInline(content) });
        this.pos = eol + 1;
        return true;
      }
      return false;
    }

    const marker = matchListMarker(src, p, eol);
    if (marker) {
      this.flushParagraph();
      this.listItem(indent, marker, parseInline(src.slice(marker.contentStart, eol).trimEnd()));
      this.pos = eol + 1;
      return true;
    }
    return false;
  }

  private closeLists(): void {
    this.lists.length = 0;
  }

  /** Consecutive "> " lines (each preceded by optional spaces) form one quote whose content is parsed as blocks. */
  private quote(firstP: number, firstEol: number): void {
    const { src } = this;
    const n = src.length;
    const lines: string[] = [];
    let p = firstP;
    let eol = firstEol;
    for (;;) {
      lines.push(src.slice(p + 2, eol));
      const next = eol + 1;
      if (next >= n) {
        this.pos = n;
        break;
      }
      let nextEol = src.indexOf('\n', next);
      if (nextEol === -1) nextEol = n;
      let q = next;
      while (q < nextEol && src.charCodeAt(q) === 32) q++;
      if (src.charCodeAt(q) === 62 && src.charCodeAt(q + 1) === 32) {
        p = q;
        eol = nextEol;
        continue;
      }
      this.pos = next;
      break;
    }
    this.out.push({ type: 'blockQuote', children: new BlockParser(lines.join('\n'), true).parse() });
  }

  private listItem(indent: number, marker: ListMarker, content: MdNode[]): void {
    const { lists } = this;
    while (lists.length > 0 && indent < lists[lists.length - 1]!.indent) lists.pop();
    const top = lists[lists.length - 1];
    if (top === undefined) {
      this.startList(this.out, indent, marker, content);
      return;
    }
    if (indent === top.indent || lists.length >= MAX_LIST_DEPTH) {
      if (top.ordered === marker.ordered) {
        top.node.items.push(content);
      } else {
        lists.pop();
        this.startList(top.container, top.indent, marker, content);
      }
      return;
    }
    // deeper indentation: nest inside the last item of the current list
    const lastItem = top.node.items[top.node.items.length - 1]!;
    this.startList(lastItem, indent, marker, content);
  }

  private startList(container: MdNode[], indent: number, marker: ListMarker, content: MdNode[]): void {
    const node: ListNode = { type: 'list', ordered: marker.ordered, start: marker.ordered ? marker.num : 1, items: [content] };
    container.push(node);
    this.lists.push({ indent, ordered: marker.ordered, node, container });
  }

  private plainLine(eol: number): void {
    const { src } = this;
    this.closeLists();
    const fi = this.fenceInLine(eol);
    if (fi >= 0) {
      const fence = parseFence(src, fi, this.lastFence);
      if (fence) {
        this.codeBlock(fi, fence);
        return;
      }
    }
    if (this.paraStart < 0) this.paraStart = this.pos;
    this.paraEnd = eol;
    this.pos = eol + 1;
    this.atLineStart = true;
  }

  /** First "```" on the current line, using a cached forward search so lines without one stay O(1). */
  private fenceInLine(eol: number): number {
    if (this.nextFence !== -1 && this.nextFence < this.pos) this.nextFence = this.src.indexOf('```', this.pos);
    return this.nextFence !== -1 && this.nextFence < eol ? this.nextFence : -1;
  }

  private codeBlock(fi: number, fence: Fence): void {
    const { src } = this;
    let onlySpaces = true;
    for (let k = this.pos; k < fi; k++) {
      if (src.charCodeAt(k) !== 32) {
        onlySpaces = false;
        break;
      }
    }
    if (onlySpaces) {
      // the newline that separated the pending paragraph from this block is consumed with the block
      if (this.paraStart >= 0) this.paraEnd = this.pos - 1;
    } else {
      if (this.paraStart < 0) this.paraStart = this.pos;
      this.paraEnd = fi;
    }
    this.flushParagraph();
    this.out.push({ type: 'codeBlock', lang: fence.lang, text: fence.text });
    this.pos = fence.end;
    if (src.charCodeAt(this.pos) === 10) {
      this.pos++;
      this.atLineStart = true;
    } else {
      this.atLineStart = false;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// inline level
// ---------------------------------------------------------------------------------------------------------------------

/** Characters that need attention in the inline scanner (ASCII only; everything >= 128 is plain text). */
const SPECIAL = new Uint8Array(128);
for (const ch of '\n\\`*_~|[]<@hH') SPECIAL[ch.charCodeAt(0)] = 1;

const RE_USER = /<@([!&]?)(\d{1,25})>/y;
const RE_CHANNEL = /<#(\d{1,25})>/y;
const RE_EMOJI = /<(a?):(\w{1,64}):(\d{1,25})>/y;
const RE_TIME = /<t:(-?\d{1,13})(?::([tTdDfFRsS]))?>/y;
const RE_SLASH = /<\/([\p{L}\p{N}_-]{1,32}(?: [\p{L}\p{N}_-]{1,32}){0,2}):\d{1,25}>/uy;
const RE_AUTOLINK = /<(https?:\/\/[^\s<>]+)>/iy;
const MAX_TIMESTAMP = 8.64e12; // seconds; the Date range

interface Frame {
  key: DelimiterKey;
  /** Index of the placeholder text node in the output list. */
  idx: number;
  /** Literal text of the still-unmatched delimiter. It becomes real text if the frame never closes. */
  ph: { type: 'text'; text: string };
  /** Unconsumed delimiter characters (1..3 for * and _, 2 for ~ and |, 1 for [). */
  len: number;
  /** Deepest node created directly inside this frame so far. */
  childMax: number;
  /** Removed from `byKey` (cannot match any more) but still on the global stack. */
  inert: boolean;
}

function mergeText(nodes: MdNode[]): MdNode[] {
  const result: MdNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        if (node.text === '') break;
        const last = result[result.length - 1];
        if (last !== undefined && last.type === 'text') last.text += node.text;
        else result.push({ type: 'text', text: node.text });
        break;
      }
      case 'strong':
      case 'em':
      case 'underline':
      case 'strike':
      case 'spoiler':
      case 'link':
        result.push({ ...node, children: mergeText(node.children) });
        break;
      default:
        result.push(node);
    }
  }
  return result;
}

/** Links cannot contain links: inside link text a bare URL degrades to its text. */
function stripLinks(nodes: MdNode[]): MdNode[] {
  const result: MdNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'link':
        for (const child of stripLinks(node.children)) result.push(child);
        break;
      case 'strong':
      case 'em':
      case 'underline':
      case 'strike':
      case 'spoiler':
        result.push({ ...node, children: stripLinks(node.children) });
        break;
      default:
        result.push(node);
    }
  }
  return result;
}

class InlineParser {
  private readonly n: number;
  private readonly out: MdNode[] = [];
  private readonly frames: Frame[] = [];
  private readonly byKey: Record<DelimiterKey, Frame[]> = { '*': [], _: [], '~': [], '|': [], '[': [] };
  private i = 0;
  private textStart = 0;
  /** Shared work allowance for link destinations / titles: keeps adversarial "[a](" floods linear. */
  private budget: number;
  private readonly lastCloseBracket: number;
  private tickRuns: Map<number, number[]> | null = null;
  private readonly tickCursor = new Map<number, number>();

  constructor(private readonly s: string) {
    this.n = s.length;
    this.budget = 8 * this.n + 1024;
    this.lastCloseBracket = s.lastIndexOf(']');
  }

  parse(): MdNode[] {
    const { s, n } = this;
    while (this.i < n) {
      const c = s.charCodeAt(this.i);
      if (c >= 128 || SPECIAL[c] === 0) {
        this.i++;
        continue;
      }
      switch (c) {
        case 10:
          this.flushText(this.i);
          this.out.push({ type: 'br' });
          this.i++;
          this.textStart = this.i;
          break;
        case 92:
          this.escape();
          break;
        case 96:
          this.codeSpan();
          break;
        case 42:
        case 95:
          this.emphasisRun(c);
          break;
        case 126:
        case 124:
          this.pairRun(c);
          break;
        case 91:
          this.openBracket();
          break;
        case 93:
          this.closeBracket();
          break;
        case 60:
          this.angle();
          break;
        case 64:
          this.atMention();
          break;
        default:
          this.bareUrl(); // 'h' / 'H'
      }
    }
    this.flushText(n);
    return mergeText(this.out);
  }

  private flushText(end: number): void {
    if (end > this.textStart) this.out.push({ type: 'text', text: this.s.slice(this.textStart, end) });
    this.textStart = end;
  }

  // -- escapes ----------------------------------------------------------------------------------------------------

  private escape(): void {
    const { s, n } = this;
    const at = this.i;
    const cp = at + 1 < n ? s.codePointAt(at + 1)! : -1;
    if (cp === -1 || isAsciiAlnum(cp) || isSpace(cp)) {
      this.i++;
      return;
    }
    this.flushText(at);
    this.textStart = at + 1; // the escaped character starts the next literal run
    this.i = at + 1 + (cp > 0xffff ? 2 : 1);
  }

  // -- code spans -------------------------------------------------------------------------------------------------

  private findTickCloser(start: number, length: number): number {
    if (this.tickRuns === null) {
      const runs = new Map<number, number[]>();
      const { s, n } = this;
      let p = s.indexOf('`');
      while (p !== -1) {
        let e = p + 1;
        while (e < n && s.charCodeAt(e) === 96) e++;
        const list = runs.get(e - p);
        if (list) list.push(p);
        else runs.set(e - p, [p]);
        p = e < n ? s.indexOf('`', e) : -1;
      }
      this.tickRuns = runs;
    }
    const list = this.tickRuns.get(length);
    if (list === undefined) return -1;
    let c = this.tickCursor.get(length) ?? 0;
    while (c < list.length && list[c]! <= start) c++;
    this.tickCursor.set(length, c);
    return c < list.length ? list[c]! : -1;
  }

  private codeSpan(): void {
    const { s, n } = this;
    const start = this.i;
    let end = start + 1;
    while (end < n && s.charCodeAt(end) === 96) end++;
    const closer = this.findTickCloser(start, end - start);
    if (closer === -1) {
      this.i = end; // unmatched run stays literal
      return;
    }
    this.flushText(start);
    let body = s.slice(end, closer);
    if (body.length >= 2 && body.charCodeAt(0) === 32 && body.charCodeAt(body.length - 1) === 32) {
      for (let k = 0; k < body.length; k++) {
        if (body.charCodeAt(k) !== 32) {
          body = body.slice(1, -1); // CommonMark: one padding space on each side is not part of the code
          break;
        }
      }
    }
    this.out.push({ type: 'inlineCode', text: body });
    this.i = closer + (end - start);
    this.textStart = this.i;
  }

  // -- delimiter frames -------------------------------------------------------------------------------------------

  private pushFrame(key: DelimiterKey, text: string): void {
    const ph = { type: 'text' as const, text };
    this.frames.push({ key, idx: this.out.length, ph, len: text.length, childMax: 0, inert: false });
    this.byKey[key].push(this.frames[this.frames.length - 1]!);
    this.out.push(ph);
  }

  /** Turn every frame above `f` into literal text; their already-built children now belong to `f`. */
  private dissolveAbove(f: Frame): void {
    const { frames } = this;
    for (;;) {
      const top = frames[frames.length - 1]!;
      if (top === f) return;
      frames.pop();
      if (!top.inert) this.byKey[top.key].pop();
      if (top.childMax > f.childMax) f.childMax = top.childMax;
    }
  }

  private bumpParent(depth: number): void {
    const parent = this.frames[this.frames.length - 1];
    if (parent !== undefined && depth > parent.childMax) parent.childMax = depth;
  }

  /** `f` (top of the stack) will never close: it stays literal and its content moves to the parent frame. */
  private discardFrame(f: Frame): void {
    this.frames.pop();
    this.byKey[f.key].pop();
    this.bumpParent(f.childMax);
  }

  /** Wrap everything after `f`'s placeholder into a node. Returns false when MAX_DEPTH would be exceeded. */
  private close(f: Frame, type: EmphasisType, use: number): boolean {
    this.dissolveAbove(f);
    const depth = f.childMax + 1;
    if (depth > MAX_DEPTH) {
      this.discardFrame(f);
      return false;
    }
    const children = this.out.splice(f.idx + 1);
    const node = { type, children } as MdNode;
    f.len -= use;
    if (f.len > 0) {
      f.ph.text = f.ph.text.slice(0, f.len);
      this.out.push(node);
      f.childMax = depth;
    } else {
      this.out[f.idx] = node;
      this.frames.pop();
      this.byKey[f.key].pop();
      this.bumpParent(depth);
    }
    return true;
  }

  private runEnd(start: number, ch: number): number {
    let end = start + 1;
    while (end < this.n && this.s.charCodeAt(end) === ch) end++;
    return end;
  }

  /** `*` and `_` runs: italic (1), bold / underline (2), both (3). `_` additionally needs word boundaries. */
  private emphasisRun(ch: number): void {
    const { s, n } = this;
    const start = this.i;
    const end = this.runEnd(start, ch);
    const run = end - start;
    const key = (ch === 42 ? '*' : '_') as DelimiterKey;
    const prev = start > 0 ? s.charCodeAt(start - 1) : -1;
    const next = end < n ? s.charCodeAt(end) : -1;
    let canOpen = next !== -1 && !isSpace(next);
    let canClose = prev !== -1 && !isSpace(prev);
    // Only a single underscore is subject to word boundaries (snake_case_name); like Discord, "__" underlines intraword.
    if (key === '_' && run === 1) {
      if (prev !== -1 && isAsciiAlnum(prev)) canOpen = false;
      if (next !== -1 && isAsciiAlnum(next)) canClose = false;
    }
    this.flushText(start);
    let rem = run;
    if (canClose) {
      const stack = this.byKey[key];
      while (rem > 0 && stack.length > 0) {
        const f = stack[stack.length - 1]!;
        if (this.out.length <= f.idx + 1) break; // nothing between the markers
        const use = f.len >= 2 && rem >= 2 ? 2 : 1;
        const type: EmphasisType = use === 2 ? (key === '*' ? 'strong' : 'underline') : 'em';
        if (this.close(f, type, use)) rem -= use;
      }
    }
    if (rem > 0 && canOpen) {
      const extra = Math.max(0, rem - 3); // at most three markers can ever be used (bold + italic)
      if (extra > 0) this.out.push({ type: 'text', text: key.repeat(extra) });
      this.pushFrame(key, key.repeat(rem - extra));
      this.textStart = end;
    } else {
      this.textStart = start + (run - rem); // unused markers are literal
    }
    this.i = end;
  }

  /** `~~` and `||`: always in pairs, no flanking rules; an empty pair never closes. */
  private pairRun(ch: number): void {
    const start = this.i;
    const end = this.runEnd(start, ch);
    const key = (ch === 126 ? '~' : '|') as DelimiterKey;
    const type: EmphasisType = ch === 126 ? 'strike' : 'spoiler';
    this.flushText(start);
    let at = start;
    while (end - at >= 2) {
      const stack = this.byKey[key];
      const f = stack[stack.length - 1];
      if (f !== undefined && this.out.length > f.idx + 1) {
        if (this.close(f, type, 2)) at += 2;
      } else {
        this.pushFrame(key, key + key);
        at += 2;
      }
    }
    this.textStart = at;
    this.i = end;
  }

  // -- links ------------------------------------------------------------------------------------------------------

  private openBracket(): void {
    if (this.lastCloseBracket < this.i) {
      this.i++;
      return;
    }
    this.flushText(this.i);
    this.pushFrame('[', '[');
    this.i++;
    this.textStart = this.i;
  }

  private skipBlanks(from: number): number {
    const { s, n } = this;
    let k = from;
    while (k < n && --this.budget >= 0) {
      const c = s.charCodeAt(k);
      if (c !== 32 && c !== 9 && c !== 10) break;
      k++;
    }
    return k;
  }

  /** `(url)`, `(<url>)`, `(url "title")` starting at the "(" at `p`. The title is validated but not kept. */
  private parseDestination(p: number): { url: string; end: number } | null {
    const { s, n } = this;
    let i = this.skipBlanks(p + 1);
    let raw: string;
    if (s.charCodeAt(i) === 60) {
      let j = i + 1;
      for (;;) {
        if (j >= n || --this.budget < 0) return null;
        const c = s.charCodeAt(j);
        if (c === 62) break;
        if (c === 60 || c === 10) return null;
        if (c === 92) j++;
        j++;
      }
      raw = s.slice(i + 1, j);
      i = j + 1;
    } else {
      let depth = 0;
      let j = i;
      for (; j < n; j++) {
        if (--this.budget < 0) return null;
        const c = s.charCodeAt(j);
        if (c === 92 && j + 1 < n) {
          j++;
          continue;
        }
        if (isSpace(c)) break;
        if (c === 40) depth++;
        else if (c === 41) {
          if (depth === 0) break;
          depth--;
        }
      }
      if (j === i || j >= n) return null;
      raw = s.slice(i, j);
      i = j;
    }
    i = this.skipBlanks(i);
    const quote = s.charCodeAt(i);
    if (quote === 34 || quote === 39) {
      let k = i + 1;
      const limit = Math.min(n, i + 513);
      while (k < limit && s.charCodeAt(k) !== quote) k++;
      this.budget -= k - i;
      if (k >= limit || this.budget < 0) return null;
      i = this.skipBlanks(k + 1);
    }
    if (s.charCodeAt(i) !== 41) return null;
    const url = raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    if (!/^https?:\/\//i.test(url) || safeUrl(url) === null) return null;
    return { url, end: i + 1 };
  }

  private isBlankFrom(from: number): boolean {
    for (let k = from; k < this.out.length; k++) {
      const node = this.out[k]!;
      if (node.type !== 'text' || node.text.trim() !== '') return false;
    }
    return true;
  }

  private closeBracket(): void {
    const stack = this.byKey['['];
    const f = stack[stack.length - 1];
    const at = this.i;
    if (f === undefined) {
      this.i++;
      return;
    }
    const dest = this.s.charCodeAt(at + 1) === 40 ? this.parseDestination(at + 1) : null;
    if (dest === null) {
      stack.pop();
      f.inert = true; // "[x]" without a destination: this opener is dead, the "]" is literal
      this.i++;
      return;
    }
    this.flushText(at);
    this.dissolveAbove(f);
    if (this.isBlankFrom(f.idx + 1) || f.childMax + 1 > MAX_DEPTH) {
      stack.pop();
      f.inert = true;
      this.textStart = at;
      this.i++;
      return;
    }
    const depth = f.childMax + 1;
    const children = stripLinks(this.out.splice(f.idx + 1));
    this.out[f.idx] = { type: 'link', url: dest.url, children, masked: true };
    this.frames.pop();
    for (const g of stack) g.inert = true; // links cannot nest: earlier "[" can no longer close
    stack.length = 0;
    this.bumpParent(depth);
    this.i = dest.end;
    this.textStart = dest.end;
  }

  // -- <...> constructs and bare tokens ---------------------------------------------------------------------------

  private angle(): void {
    const { s } = this;
    const at = this.i;
    const next = s.charCodeAt(at + 1);
    let node: MdNode | null = null;
    let m: RegExpExecArray | null = null;
    if (next === 64) {
      RE_USER.lastIndex = at;
      m = RE_USER.exec(s);
      if (m) node = m[1] === '&' ? { type: 'mentionRole', id: m[2]! } : { type: 'mentionUser', id: m[2]! };
    } else if (next === 35) {
      RE_CHANNEL.lastIndex = at;
      m = RE_CHANNEL.exec(s);
      if (m) node = { type: 'mentionChannel', id: m[1]! };
    } else if (next === 58 || next === 97) {
      RE_EMOJI.lastIndex = at;
      m = RE_EMOJI.exec(s);
      if (m) node = { type: 'emoji', name: m[2]!, id: m[3]!, animated: m[1] === 'a' };
    } else if (next === 116) {
      RE_TIME.lastIndex = at;
      m = RE_TIME.exec(s);
      if (m) {
        const unix = Number(m[1]);
        if (Math.abs(unix) <= MAX_TIMESTAMP) {
          node = { type: 'timestamp', unix, style: (m[2] ?? 'f') as TimestampNode['style'] };
        }
      }
    } else if (next === 47) {
      RE_SLASH.lastIndex = at;
      m = RE_SLASH.exec(s);
      if (m) node = { type: 'text', text: `/${m[1]!}` };
    } else if (next === 104 || next === 72) {
      RE_AUTOLINK.lastIndex = at;
      m = RE_AUTOLINK.exec(s);
      if (m && safeUrl(m[1]!) !== null) {
        node = { type: 'link', url: m[1]!, children: [{ type: 'text', text: m[1]! }], masked: false };
      }
    }
    if (node === null || m === null) {
      this.i++;
      return;
    }
    const end = at + m[0].length;
    this.flushText(at);
    this.out.push(node);
    this.i = end;
    this.textStart = end;
  }

  private atMention(): void {
    const { s } = this;
    const at = this.i;
    const length = s.startsWith('everyone', at + 1) ? 8 : s.startsWith('here', at + 1) ? 4 : 0;
    if (length === 0) {
      this.i++;
      return;
    }
    const prev = at > 0 ? s.charCodeAt(at - 1) : -1;
    const next = s.charCodeAt(at + 1 + length); // NaN past the end
    const wordish = (c: number): boolean => isAsciiAlnum(c) || c === 95;
    if (wordish(prev) || wordish(next)) {
      this.i++;
      return;
    }
    this.flushText(at);
    this.out.push(length === 8 ? { type: 'mentionEveryone' } : { type: 'mentionHere' });
    this.i = at + 1 + length;
    this.textStart = this.i;
  }

  /** Trailing punctuation / unbalanced closers / our own pending emphasis markers are not part of a bare URL. */
  private trimUrlEnd(start: number, rawEnd: number): number {
    const { s } = this;
    let e = rawEnd;
    let counts: { po: number; pc: number; bo: number; bc: number } | null = null;
    while (e > start) {
      const c = s.charCodeAt(e - 1);
      if (c === 46 || c === 44 || c === 58 || c === 59 || c === 33 || c === 63 || c === 34 || c === 39) {
        e--;
      } else if (c === 41 || c === 93) {
        if (counts === null) {
          counts = { po: 0, pc: 0, bo: 0, bc: 0 };
          for (let k = start; k < rawEnd; k++) {
            const d = s.charCodeAt(k);
            if (d === 40) counts.po++;
            else if (d === 41) counts.pc++;
            else if (d === 91) counts.bo++;
            else if (d === 93) counts.bc++;
          }
        }
        if (c === 41 && counts.pc > counts.po) {
          counts.pc--;
          e--;
        } else if (c === 93 && counts.bc > counts.bo) {
          counts.bc--;
          e--;
        } else {
          break;
        }
      } else if (
        (c === 42 || c === 95 || c === 126 || c === 124) &&
        this.byKey[String.fromCharCode(c) as DelimiterKey].length > 0
      ) {
        e--; // "**https://x**": the closing markers belong to the open emphasis
      } else {
        break;
      }
    }
    return e;
  }

  private bareUrl(): void {
    const { s, n } = this;
    const at = this.i;
    if ((s.charCodeAt(at + 1) | 32) !== 116 || (s.charCodeAt(at + 2) | 32) !== 116 || (s.charCodeAt(at + 3) | 32) !== 112) {
      this.i++;
      return;
    }
    let p = at + 4;
    if ((s.charCodeAt(p) | 32) === 115) p++;
    if (s.charCodeAt(p) !== 58 || s.charCodeAt(p + 1) !== 47 || s.charCodeAt(p + 2) !== 47) {
      this.i++;
      return;
    }
    const bodyStart = p + 3;
    const stopAtBracket = this.byKey['['].length > 0;
    let rawEnd = bodyStart;
    while (rawEnd < n) {
      const c = s.charCodeAt(rawEnd);
      if (isSpace(c) || c === 60 || (stopAtBracket && c === 93)) break;
      rawEnd++;
    }
    const end = this.trimUrlEnd(bodyStart, rawEnd);
    const url = s.slice(at, end);
    if (end <= bodyStart || safeUrl(url) === null) {
      this.i = Math.max(rawEnd, at + 1); // skip the whole token so it is never rescanned
      return;
    }
    this.flushText(at);
    this.out.push({ type: 'link', url, children: [{ type: 'text', text: url }], masked: false });
    this.i = end;
    this.textStart = end;
  }
}

function parseInline(src: string): MdNode[] {
  return src === '' ? [] : new InlineParser(src).parse();
}

/**
 * Parse Discord markdown. Never throws, never recurses deeper than a few dozen frames and runs in (amortised)
 * linear time, whatever the input.
 */
export function parseMarkdown(src: string): MdNode[] {
  if (src === '') return [];
  const text = src.includes('\r') ? src.replace(/\r\n?/g, '\n') : src;
  return new BlockParser(text, false).parse();
}

// ---------------------------------------------------------------------------------------------------------------------
// jumbo emoji helpers
// ---------------------------------------------------------------------------------------------------------------------

const PICTO = String.raw`\p{Extended_Pictographic}`;
const MODIFIER = String.raw`(?:️|\p{Emoji_Modifier})?`;
const EMOJI_SOURCE = String.raw`\p{Regional_Indicator}{2}|[#*0-9]️?⃣|${PICTO}${MODIFIER}(?:[\u{E0020}-\u{E007F}]+|(?:‍${PICTO}${MODIFIER})*)`;
const EMOJI_STICKY = new RegExp(EMOJI_SOURCE, 'uy');
const EMOJI_GLOBAL = new RegExp(EMOJI_SOURCE, 'ug');
/** (c) (r) (tm) are "pictographic" in Unicode but are ordinary text unless explicitly emoji-presented. */
const TEXT_SYMBOLS = new Set(['©', '®', '™']);

export interface EmojiRun {
  text: string;
  emoji: boolean;
}

/** Splits text into unicode-emoji runs and the text between them (used by the renderers for jumbo emoji). */
export function splitUnicodeEmoji(text: string): EmojiRun[] {
  const runs: EmojiRun[] = [];
  let last = 0;
  EMOJI_GLOBAL.lastIndex = 0;
  for (let m = EMOJI_GLOBAL.exec(text); m !== null; m = EMOJI_GLOBAL.exec(text)) {
    if (TEXT_SYMBOLS.has(m[0])) continue;
    if (m.index > last) runs.push({ text: text.slice(last, m.index), emoji: false });
    runs.push({ text: m[0], emoji: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), emoji: false });
  return runs;
}

/** Number of unicode emoji in `text` if it consists of nothing but emoji and whitespace, else -1. */
function countOnlyEmoji(text: string): number {
  let count = 0;
  let pos = 0;
  while (pos < text.length) {
    if (isSpace(text.charCodeAt(pos))) {
      pos++;
      continue;
    }
    EMOJI_STICKY.lastIndex = pos;
    const m = EMOJI_STICKY.exec(text);
    if (m === null || TEXT_SYMBOLS.has(m[0])) return -1;
    pos += m[0].length;
    count++;
  }
  return count;
}

/** Emoji count (custom + unicode) when the message is emoji and whitespace only; 0 otherwise. */
export function emojiOnlyCount(nodes: MdNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'emoji') {
      count++;
    } else if (node.type === 'text') {
      const c = countOnlyEmoji(node.text);
      if (c < 0) return 0;
      count += c;
    } else if (node.type !== 'br') {
      return 0;
    }
  }
  return count;
}

/** True when the message should be shown with jumbo emoji: 1..27 emoji and nothing else. */
export function isEmojiOnly(nodes: MdNode[]): boolean {
  const count = emojiOnlyCount(nodes);
  return count >= 1 && count <= JUMBO_EMOJI_MAX;
}
