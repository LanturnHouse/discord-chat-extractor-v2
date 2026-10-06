import markdownCss from './markdown.css?raw';
import messageCss from './message.css?raw';
import themeCss from './theme.css?raw';

/**
 * The single `<style>` block of an exported HTML file: theme tokens (dark = theme.css, light = defined here), markdown.css
 * and message.css (the Discord look of messages) and a few rules for the page around the messages (header card, footer).
 * There is no script in the export, so nothing ever switches the theme at run time: `<html data-theme>` picks one of the
 * two token blocks (`ExportSettings.htmlTheme`).
 */

/** Values of the light theme (Discord's light palette). A token that is not listed keeps its dark value. */
const LIGHT_TOKENS: Readonly<Record<string, string>> = {
  '--bg-primary': '#ffffff',
  '--bg-secondary': '#f2f3f5',
  '--bg-tertiary': '#e3e5e8',
  '--bg-message-hover': '#f7f7f8',
  '--bg-modifier-hover': 'rgba(116, 127, 141, 0.12)',
  '--bg-modifier-active': 'rgba(116, 127, 141, 0.2)',
  '--bg-modifier-selected': 'rgba(116, 127, 141, 0.3)',
  '--code-bg': '#f2f3f5',
  '--embed-bg': '#f2f3f5',
  '--text-normal': '#313338',
  '--text-header': '#060607',
  '--text-muted': '#5c5e66',
  '--link': '#006ce7',
  '--channel-icon': '#5c5e66',
  '--interactive-normal': '#4e5058',
  '--interactive-hover': '#313338',
  '--interactive-active': '#060607',
  '--interactive-muted': '#c4c9ce',
  '--brand': '#5865f2',
  '--danger': '#d83c3e',
  '--divider': '#e1e2e4',
};

/**
 * Page chrome and the light-theme corrections for colours that message.css / markdown.css hard-code for the dark theme
 * (mention chips, reply connector, quote bars). Written after those files so that equal specificity resolves in its favour.
 */
const EXPORT_CSS = `
html { background: var(--bg-primary); }
body {
  margin: 0;
  background: var(--bg-primary);
  color: var(--text-normal);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.375;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
.dce-page { box-sizing: border-box; max-width: 1000px; margin: 0 auto; padding: 16px 0 32px; }

.dce-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 8px 16px 16px;
  padding: 16px 20px;
  border-radius: 8px;
  background: var(--bg-secondary);
}
.dce-header__icon,
.dce-header__acronym { flex: none; width: 64px; height: 64px; border-radius: 50%; }
.dce-header__icon { background: var(--bg-tertiary); object-fit: cover; }
.dce-header__acronym {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand);
  color: #fff;
  font-size: 1.5rem;
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
.dce-header__text { flex: 1 1 auto; min-width: 0; }
.dce-header__title { margin: 0; color: var(--text-header); font-size: 1.5rem; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
.dce-header__channel { margin-top: 2px; color: var(--text-header); font-weight: 600; overflow-wrap: anywhere; }
.dce-header__topic { margin: 4px 0 0; color: var(--text-muted); font-size: 0.875rem; overflow-wrap: anywhere; }

.dce-meta {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 12px;
  margin: 12px 0 0;
  color: var(--text-muted);
  font-size: 0.8125rem;
  line-height: 1.25rem;
}
.dce-meta dt { font-weight: 600; }
.dce-meta dd { margin: 0; overflow-wrap: anywhere; }

.dce-empty { margin: 32px 16px; color: var(--text-muted); text-align: center; }

.dce-footer { margin: 24px 16px 0; padding-top: 16px; border-top: 1px solid var(--divider); color: var(--text-muted); font-size: 0.875rem; }
.dce-footer .dce-meta { margin-top: 0; }
.dce-footer__note { margin: 12px 0 0; }

.msg-attachment--spoiler:is(:hover, :focus-within) .msg-image { filter: none; transform: none; }
.msg-attachment--spoiler:is(:hover, :focus-within) .msg-spoiler-cover { opacity: 0; pointer-events: none; }
.msg-spoiler-cover:focus-visible { outline: 2px solid var(--link, #00a8fc); outline-offset: -2px; }

@media (max-width: 600px) {
  .dce-header { padding: 12px 16px; }
  .msg { padding-right: 16px; }
}

:root[data-theme='light'] .md-mention { background: rgba(88, 101, 242, 0.15); color: #3c45a5; }
:root[data-theme='light'] .md-mention:hover { background: var(--brand); color: #fff; }
:root[data-theme='light'] .msg-reaction--me .msg-reaction__count { color: #3c45a5; }
:root[data-theme='light'] .msg-reply::before { border-color: #c4c9ce; }
:root[data-theme='light'] .md-quote,
:root[data-theme='light'] .msg-forward { border-left-color: #c4c9ce; }
`;

/** Comments and layout whitespace out; nothing that could change what a selector or a value means. */
function compact(css: string): string {
  return css
    .replace(/\/\*[^]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{};]) ?/g, '$1')
    .trim();
}

/** `--name: value` pairs of the first `:root` rule. */
function readTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const body = /:root\s*\{([^}]*)\}/.exec(css.replace(/\/\*[^]*?\*\//g, ''))?.[1] ?? '';
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(match[1]!, match[2]!.trim().replace(/\s+/g, ' '));
  return tokens;
}

function declarations(tokens: ReadonlyMap<string, string>, names: readonly string[]): string {
  return names.flatMap((name) => (tokens.has(name) ? [`${name}:${tokens.get(name)}`] : [])).join(';');
}

/**
 * Always defined, whether the CSS reads them or not: they are the palette of the visual spec, which a reader editing
 * the exported file can rely on.
 */
const CORE_TOKENS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-message-hover',
  '--text-normal',
  '--text-header',
  '--text-muted',
  '--channel-icon',
  '--divider',
  '--brand',
  '--link',
  '--embed-bg',
  '--code-bg',
];

/** The core palette plus every custom property that `css` reads and the app's theme defines (`--msg-*` are local to message.css). */
function usedTokens(css: string, known: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>(CORE_TOKENS.filter((name) => known.has(name)));
  for (const match of css.matchAll(/var\(\s*(--[\w-]+)/g)) if (known.has(match[1]!)) names.add(match[1]!);
  return [...names].sort();
}

interface Built {
  css: string;
  tokens: string[];
}

let built: Built | undefined;

function build(): Built {
  if (built === undefined) {
    const rules = compact(`${markdownCss}\n${messageCss}\n${EXPORT_CSS}`);
    const dark = readTokens(themeCss);
    const tokens = usedTokens(rules, dark);
    const light = new Map(Object.entries(LIGHT_TOKENS));
    built = {
      css:
        `:root{color-scheme:dark;${declarations(dark, tokens)}}` +
        `:root[data-theme='light']{color-scheme:light;${declarations(light, tokens)}}` +
        rules,
      tokens,
    };
  }
  return built;
}

/** Contents of the `<style>` element. Static, so it is built once and contains nothing from the exported messages. */
export function exportStyles(): string {
  return build().css;
}

/** Names of the theme tokens the style block defines (for both themes); exposed for tests. */
export function exportedTokenNames(): readonly string[] {
  return build().tokens;
}
