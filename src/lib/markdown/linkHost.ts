/**
 * Link-text spoofing guard. `[https://discord.com/login](https://evil.example/x)` shows one address and opens another, and
 * the browser's hover tooltip is the only hint. Both renderers (React and HTML) append the real host to the visible text
 * of such a link, so the app and an exported file that is shared with third parties (no script, no confirm dialog)
 * tell the same story. Plain-text exports already print `label (url)`.
 */

/** Zero-width / bidi / soft-hyphen characters: they take no room but make `disc` + zero-width space + `ord.com` look like `discord.com`. */
const INVISIBLE = /\p{Cf}/gu;

/** A word of the label; brackets and quotes only wrap addresses, they never belong to one. */
const WORD = /[^\s<>"'`()[\]{}|\\^]+/gu;

/**
 * Everything that can be part of a dot-separated name. Names are found by cutting a word at the first character outside this
 * set, not with a pattern like `(label\.)+tld`: the label text is attacker-controlled, and that pattern backtracks quadratically
 * on `a.a.a.a.` repeated. Deliberately found anywhere in a word, so that `https∶//discord.com` (look-alike colon) is seen too.
 */
const NAME_RUN = /[\p{L}\p{N}_.-]+/gu;

/** No domain name is longer than this; anything longer is not worth a URL parse (and bounds the work of one name). */
const MAX_NAME_LENGTH = 253;

/** File names that look like a domain (`Next.js`, `README.md`) are not addresses somebody would spoof. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'md', 'txt', 'py', 'rb', 'php', 'html', 'htm', 'css', 'scss', 'java', 'kt',
  'cpp', 'hpp', 'yml', 'yaml', 'toml', 'xml', 'csv', 'log', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'exe', 'dll',
  'bat', 'ini', 'cfg', 'conf', 'lock', 'bin', 'iso', 'apk', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp3', 'mp4', 'wav',
  'avi',
]);

/** A real top-level domain is letters (or the punycode form of an internationalised one), never digits: `v1.2.3` is a version. */
const TOP_LEVEL = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;

const withoutWww = (host: string): string => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** The ASCII (punycode) host a browser would use for `name`, or null when it is not a domain name worth comparing. */
function hostOfName(name: string): string | null {
  if (name.length > MAX_NAME_LENGTH || name.startsWith('.') || name.endsWith('.') || name.includes('..')) return null;
  let host: string;
  try {
    host = new URL(`https://${name}`).hostname;
  } catch {
    return null;
  }
  const topLevel = host.slice(host.lastIndexOf('.') + 1);
  return TOP_LEVEL.test(topLevel) && !FILE_EXTENSIONS.has(topLevel) ? host : null;
}

/**
 * Every host a word of the label presents as an address. Scanning stops at the first `/`, `?` or `#` after a name: what
 * follows is a path (`example.com/archive.tar.gz`), not another site. Names before an `@` are kept, because
 * `https://good.com@evil.example` is exactly the trick that makes the trusted name look like the destination.
 */
function hostsOfWord(word: string, hostOf: (name: string) => string | null): string[] {
  const hosts: string[] = [];
  NAME_RUN.lastIndex = 0;
  for (let match = NAME_RUN.exec(word); match !== null; match = NAME_RUN.exec(word)) {
    const run = match[0];
    // A sentence's full stop sticks to the last name (`see example.com.`).
    const name = run.replace(/\.+$/, '');
    if (name.includes('.')) {
      const host = hostOf(name);
      if (host !== null) hosts.push(host);
    }
    const next = word[match.index + run.length];
    if (next === '/' || next === '?' || next === '#') break;
  }
  return hosts;
}

/** The visible note appended inside the link; one function so that the app and the exported file cannot drift apart. */
export function linkHostNote(host: string): string {
  return ` ↗ (${host})`;
}

/**
 * The real host of a masked link to show next to its text, or null when the text does not claim to be another address.
 * The text "claims" an address when one of its words is a URL or a domain (with or without scheme, path or userinfo) whose
 * host differs from the target's; `www.` and letter case do not count as a difference. Internationalised names are
 * compared and shown in punycode, which also exposes look-alike (homograph) targets.
 *
 * @param label visible text of the link (plain text, formatting removed)
 * @param href the target, already checked with `safeUrl`
 */
export function misleadingLinkHost(label: string, href: string): string | null {
  // NFKC folds full-width letters and dots; the ideographic full stops (U+3002, U+FF61) are dots to URL parsers too.
  const text = label.normalize('NFKC').replace(INVISIBLE, '').replace(/[。｡]/g, '.');
  if (!text.includes('.')) return null;
  let target: URL;
  try {
    target = new URL(href);
  } catch {
    return null;
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.hostname === '') return null;

  const real = withoutWww(target.hostname);
  // A label that repeats one name thousands of times is parsed once.
  const known = new Map<string, string | null>();
  const hostOf = (name: string): string | null => {
    if (!known.has(name)) known.set(name, hostOfName(name));
    return known.get(name) ?? null;
  };
  for (const word of text.match(WORD) ?? []) {
    if (word.includes('.') && hostsOfWord(word, hostOf).some((shown) => withoutWww(shown) !== real)) return target.host;
  }
  return null;
}
