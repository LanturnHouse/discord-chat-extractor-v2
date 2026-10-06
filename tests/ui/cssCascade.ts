/**
 * A small CSS reader for the tests that pin colours: it parses the flat rules of the popup's stylesheets, resolves `var()`
 * chains against a property map, and runs the part of the cascade that decides the text colour of an element
 * (specificity, source order, inheritance), so a test can say what a label inside a control really renders in, not only what
 * the control's own rule declares. Selectors support what these files use: compound selectors of classes, attributes and
 * pseudo-classes (also `:not(...)`) joined by the descendant combinator. A selector it cannot read never matches.
 */
import componentsCss from '@/ui/components/components.css?raw';
import settingsCss from '@/ui/settings/settings.css?raw';
import themeCss from '@/ui/theme/theme.css?raw';
import popupCss from '@/popup/popup.css?raw';

// --- rules --------------------------------------------------------------------------------------------------------------

export interface Rule {
  selectors: string[];
  decl: Record<string, string>;
}

export const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

export function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (selector.startsWith('@') || /^(?:from|to|\d+%)$/.test(selector)) continue;
    const decl: Record<string, string> = {};
    for (const part of match[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) decl[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(/\s+/g, ' ');
    }
    rules.push({ selectors: selector.split(',').map((one) => one.trim().replace(/\s+/g, ' ')), decl });
  }
  return rules;
}

/** In the order the popup loads them (a later rule of equal specificity wins). */
export const FILES = { 'theme.css': themeCss, 'components.css': componentsCss, 'settings.css': settingsCss, 'popup.css': popupCss } as const;
export const allRules = (): Rule[] => Object.values(FILES).flatMap((css) => parseRules(css));
export const rulesFor = (selector: string): Rule[] => allRules().filter((rule) => rule.selectors.includes(selector));
export const declOf = (selector: string, property: string): string | undefined => rulesFor(selector).find((rule) => property in rule.decl)?.decl[property];

/** The custom properties theme.css declares (dark palette, and the light one laid over it for 'light'). */
export function stylesheetProps(scheme: 'dark' | 'light'): Record<string, string> {
  const props: Record<string, string> = {};
  const rules = parseRules(themeCss);
  const take = (selector: string): void => {
    for (const rule of rules) {
      if (!rule.selectors.includes(selector)) continue;
      for (const [name, value] of Object.entries(rule.decl)) if (name.startsWith('--')) props[name] = value;
    }
  };
  take(':root');
  if (scheme === 'light') take(":root[data-theme='light']");
  return props;
}

/** `var(--a, var(--b, #fff))` against a property map, the way the browser resolves it. */
export function resolve(value: string, props: Record<string, string>, depth = 0): string {
  if (depth > 30) throw new Error(`var() cycle in ${value}`);
  let out = '';
  let at = 0;
  while (at < value.length) {
    const start = value.indexOf('var(', at);
    if (start < 0) {
      out += value.slice(at);
      break;
    }
    out += value.slice(at, start);
    let level = 1;
    let end = start + 4;
    while (end < value.length && level > 0) {
      if (value[end] === '(') level++;
      else if (value[end] === ')') level--;
      end++;
    }
    const inner = value.slice(start + 4, end - 1);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim();
    const own = props[name];
    out += own !== undefined ? resolve(own, props, depth + 1) : fallback !== undefined ? resolve(fallback, props, depth + 1) : '';
    at = end;
  }
  return out.trim();
}

// --- colour maths for the contrast check --------------------------------------------------------------------------------

function toRgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex !== null) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1];
    return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16)) as [number, number, number];
  }
  const hsl = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(color);
  if (hsl === null) throw new Error(`cannot read the colour ${color}`);
  const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100];
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

function luminance(color: string): number {
  const [r, g, b] = toRgb(color).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// --- selectors and the cascade ------------------------------------------------------------------------------------------

/** One element of a chain: what a selector can see of it. */
export interface Node {
  classes: readonly string[];
  attrs: Readonly<Record<string, string>>;
  /** Pseudo-classes that hold for it ('hover', 'disabled', ...). */
  states: readonly string[];
}

interface Compound {
  classes: string[];
  attrs: Array<{ name: string; value: string | undefined }>;
  pseudos: string[];
  negated: Compound[];
}

function parseCompound(text: string): Compound | null {
  const compound: Compound = { classes: [], attrs: [], pseudos: [], negated: [] };
  let rest = text;
  while (rest.length > 0) {
    let m: RegExpExecArray | null;
    if ((m = /^\.([\w-]+)/.exec(rest)) !== null) compound.classes.push(m[1]);
    else if ((m = /^\[([\w-]+)(?:=(?:'([^']*)'|"([^"]*)"|([^\]]*)))?\]/.exec(rest)) !== null) compound.attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] });
    else if ((m = /^:not\(([^()]*)\)/.exec(rest)) !== null) {
      const inner = parseCompound(m[1]);
      if (inner === null) return null;
      compound.negated.push(inner);
    } else if ((m = /^:([\w-]+)/.exec(rest)) !== null) compound.pseudos.push(m[1]);
    else return null; // an element type, `*`, `::pseudo-element`, ...: not used for the colour rules, never matches
    rest = rest.slice(m[0].length);
  }
  return compound;
}

const compoundMatches = (compound: Compound, node: Node): boolean =>
  compound.classes.every((name) => node.classes.includes(name)) &&
  compound.attrs.every(({ name, value }) => (value === undefined ? name in node.attrs : node.attrs[name] === value)) &&
  compound.pseudos.every((pseudo) => node.states.includes(pseudo)) &&
  compound.negated.every((inner) => !compoundMatches(inner, node));

const compoundWeight = (compound: Compound): number =>
  compound.classes.length + compound.attrs.length + compound.pseudos.length + compound.negated.reduce((sum, inner) => sum + compoundWeight(inner), 0);

/** The compounds of a selector, or null when it uses something this reader does not know (combinators other than a space...). */
function parseSelector(selector: string): Compound[] | null {
  if (/[>+~*]|::/.test(selector.replace(/\[[^\]]*\]/g, ''))) return null;
  const compounds: Compound[] = [];
  for (const part of selector.split(' ')) {
    const compound = parseCompound(part);
    if (compound === null) return null;
    compounds.push(compound);
  }
  return compounds;
}

/** Does `selector` match the last node of `chain` (root first)? Returns its specificity weight, or -1. */
function matchSelector(selector: string, chain: readonly Node[]): number {
  const compounds = parseSelector(selector);
  if (compounds === null || chain.length === 0) return -1;
  if (!compoundMatches(compounds[compounds.length - 1], chain[chain.length - 1])) return -1;
  let at = chain.length - 2;
  for (let index = compounds.length - 2; index >= 0; index--) {
    while (at >= 0 && !compoundMatches(compounds[index], chain[at])) at--;
    if (at < 0) return -1;
    at--;
  }
  return compounds.reduce((sum, compound) => sum + compoundWeight(compound), 0);
}

/**
 * The value `property` is declared with on the last node of `chain`: the highest specificity wins, then the later rule.
 * `undefined` when no rule sets it. (`!important` and inline styles are not used by these stylesheets.)
 */
export function declared(chain: readonly Node[], property: string | readonly string[], rules: readonly Rule[] = allRules()): string | undefined {
  const properties = typeof property === 'string' ? [property] : property;
  let best: { weight: number; value: string } | undefined;
  for (const rule of rules) {
    const value = properties.map((name) => rule.decl[name]).find((one) => one !== undefined);
    if (value === undefined) continue;
    for (const selector of rule.selectors) {
      const weight = matchSelector(selector, chain);
      if (weight >= 0 && (best === undefined || weight >= best.weight)) best = { weight, value };
    }
  }
  return best?.value;
}

/**
 * The text colour the last node of `chain` renders in, `var()` resolved against `props`: the declared colour, `inherit` and
 * "nothing declared" both taking the parent's. `undefined` when nobody up the chain sets one.
 */
export function effectiveColor(chain: readonly Node[], props: Record<string, string>, rules: readonly Rule[] = allRules()): string | undefined {
  for (let end = chain.length; end > 0; end--) {
    const value = declared(chain.slice(0, end), 'color', rules);
    if (value !== undefined && value !== 'inherit') return resolve(value, props);
  }
  return undefined;
}

/** The nearest fill (`background` / `background-color`) declared on the last node of `chain` or an ancestor that is not see-through. */
export function effectiveFill(chain: readonly Node[], rules: readonly Rule[] = allRules()): string | undefined {
  for (let end = chain.length; end > 0; end--) {
    const value = declared(chain.slice(0, end), ['background', 'background-color'], rules);
    if (value === undefined || value === 'none' || value === 'transparent' || /^(?:rgba|color-mix)\(/.test(value)) continue;
    return value;
  }
  return undefined;
}

/** The chain of `element` and its ancestors up to (and including) `root`, as selectors see them. `hover` marks the elements that are hovered. */
export function chainOf(element: Element, root: Element, hover: readonly Element[] = []): Node[] {
  const chain: Node[] = [];
  for (let current: Element | null = element; current !== null; current = current === root ? null : current.parentElement) {
    const attrs: Record<string, string> = {};
    for (const attribute of Array.from(current.attributes)) attrs[attribute.name] = attribute.value;
    const states: string[] = [];
    if (hover.includes(current)) states.push('hover');
    if ((current as HTMLButtonElement).disabled === true) states.push('disabled');
    chain.unshift({ classes: Array.from(current.classList), attrs, states });
  }
  return chain;
}
