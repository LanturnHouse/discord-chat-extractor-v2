/**
 * A small CSS cascade for the content script's tests: jsdom cannot evaluate `:hover` / `:focus-visible`, so this reads the flat
 * rules of a stylesheet, lets a test force those states on an element, and decides which declaration of a property wins (the
 * `!important` flag, then specificity, then source order; a presentation attribute loses to every rule). Enough to say what
 * `display` a glyph inside one of our buttons really gets, with Discord's own (stand-in) rules in the page too.
 *
 * What it does not do: `@media` (and other at-rules) are skipped, inline `style` is not read (a test asserts there is none),
 * no inheritance, no `var()` resolution. Selectors are matched by jsdom itself after `:hover`, `:focus-visible`, `:active` and
 * `:focus` are rewritten into attributes that `force()` sets.
 */

export interface Declaration {
  value: string;
  important: boolean;
}

export interface CascadeRule {
  /** One selector of the rule's list, as written. */
  selector: string;
  /** The same selector with the pseudo-classes rewritten to attributes (what jsdom matches). */
  testSelector: string;
  /** [ids, classes + attributes + pseudo-classes, elements + pseudo-elements]. */
  specificity: [number, number, number];
  /** Position in the page (a later rule wins a tie). */
  order: number;
  decl: Record<string, Declaration>;
}

const FORCED = {
  hover: 'data-t-hover',
  'focus-visible': 'data-t-focus-visible',
  active: 'data-t-active',
  focus: 'data-t-focus',
} as const;

type ForcedState = keyof typeof FORCED;

/** Splits at commas that are not inside parentheses or brackets. */
function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(list.slice(from));
  return parts.map((part) => part.trim().replace(/\s+/g, ' ')).filter((part) => part !== '');
}

export function specificityOf(selector: string): [number, number, number] {
  // `:not(x)` counts as its argument `x` (and nothing for the `:not` itself); the arguments used here are simple compounds.
  const bare = selector
    .replace(/\[[^\]]*\]/g, '[a]')
    .replace(/"[^"]*"/g, '')
    .replace(/:not\(([^()]*)\)/g, ' $1 ');
  const ids = (bare.match(/#[\w-]+/g) ?? []).length;
  const attributes = (bare.match(/\[a\]/g) ?? []).length;
  const classes = (bare.match(/\.[\w-]+/g) ?? []).length;
  const pseudoClasses = (bare.match(/(?<!:):(?!:)[\w-]+/g) ?? []).length;
  const pseudoElements = (bare.match(/::[\w-]+/g) ?? []).length;
  const elements = (bare.replace(/\[a\]/g, '').match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return [ids, attributes + classes + pseudoClasses, elements + pseudoElements];
}

function forceable(selector: string): string {
  return selector.replace(/(?<!:):(hover|focus-visible|active|focus)(?![\w-])/g, (_all, name: ForcedState) => `[${FORCED[name]}]`);
}

/** The style rules of `css` (at-rules skipped), one entry per selector of each list. `firstOrder` continues the numbering of an earlier sheet. */
export function parseSheet(css: string, firstOrder = 0): CascadeRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CascadeRule[] = [];
  let order = firstOrder;
  let from = 0;
  while (from < text.length) {
    const open = text.indexOf('{', from);
    if (open < 0) break;
    const prelude = text.slice(from, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < text.length && depth > 0) {
      if (text[close] === '{') depth++;
      else if (text[close] === '}') depth--;
      close++;
    }
    from = close;
    if (prelude.startsWith('@')) continue; // @media and friends: not evaluated here
    const decl: Record<string, Declaration> = {};
    for (const part of text.slice(open + 1, close - 1).split(';')) {
      const colon = part.indexOf(':');
      if (colon <= 0) continue;
      const raw = part.slice(colon + 1).trim().replace(/\s+/g, ' ');
      const important = /\s*!important$/.test(raw);
      decl[part.slice(0, colon).trim()] = { value: raw.replace(/\s*!important$/, ''), important };
    }
    for (const selector of splitList(prelude)) {
      rules.push({ selector, testSelector: forceable(selector), specificity: specificityOf(selector), order: order++, decl });
    }
  }
  return rules;
}

/** Page sheets in the order the page has them: the first is the oldest (Discord's own come before our appended `<style>`). */
export function parseSheets(...sheets: string[]): CascadeRule[] {
  const rules: CascadeRule[] = [];
  for (const sheet of sheets) rules.push(...parseSheet(sheet, rules.length));
  return rules;
}

function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false; // a selector jsdom cannot read (pseudo-elements, ...) matches nothing here
  }
}

const beats = (a: CascadeRule, aImportant: boolean, b: CascadeRule, bImportant: boolean): boolean => {
  if (aImportant !== bImportant) return aImportant;
  for (let i = 0; i < 3; i++) if (a.specificity[i] !== b.specificity[i]) return a.specificity[i]! > b.specificity[i]!;
  return a.order > b.order;
};

/** The winning value of `property` for `el` among `rules`, or undefined when no rule sets it. */
export function cascaded(el: Element, property: string, rules: readonly CascadeRule[]): string | undefined {
  let best: { rule: CascadeRule; important: boolean; value: string } | undefined;
  for (const rule of rules) {
    const declaration = rule.decl[property];
    if (!declaration || !matches(el, rule.testSelector)) continue;
    if (!best || beats(rule, declaration.important, best.rule, best.important)) {
      best = { rule, important: declaration.important, value: declaration.value };
    }
  }
  return best?.value;
}

/** The initial `display` of an element by its tag (what the browser uses when nothing declares one). */
function defaultDisplay(el: Element): string {
  return el.namespaceURI === 'http://www.w3.org/2000/svg' ? 'inline' : /^(?:DIV|P|UL|OL|LI|NAV|HEADER|H[1-6])$/.test(el.tagName) ? 'block' : 'inline';
}

/** The computed `display` of `el`: the winning rule, else the presentation attribute (svg `display="..."`), else the tag's default. */
export function displayOf(el: Element, rules: readonly CascadeRule[]): string {
  return cascaded(el, 'display', rules) ?? el.getAttribute('display') ?? defaultDisplay(el);
}

/** Is `el` drawn: neither it nor an ancestor has `display: none`? */
export function isRendered(el: Element, rules: readonly CascadeRule[]): boolean {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (displayOf(node, rules) === 'none') return false;
  }
  return true;
}

/** The pointer is on `el`: it and its ancestors are `:hover` (the way a browser does it). */
export function hover(el: Element): void {
  for (let node: Element | null = el; node !== null; node = node.parentElement) node.setAttribute(FORCED.hover, '');
}

/** `el` has keyboard focus (`:focus` and `:focus-visible`; ancestors are not affected). */
export function focusVisible(el: Element): void {
  el.setAttribute(FORCED['focus-visible'], '');
  el.setAttribute(FORCED.focus, '');
}

/** `el` is pressed (`:active`; the ancestors are too). */
export function press(el: Element): void {
  for (let node: Element | null = el; node !== null; node = node.parentElement) node.setAttribute(FORCED.active, '');
}

/** Back to the resting state: no forced pseudo-class left on `el`, its ancestors or its descendants. */
export function rest(el: Element): void {
  const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
  for (let node: Element | null = el.parentElement; node !== null; node = node.parentElement) nodes.push(node);
  for (const node of nodes) for (const attribute of Object.values(FORCED)) node.removeAttribute(attribute);
}
