import { describe, expect, it } from 'vitest';
import { markdownText } from '@/lib/export/formats/mdRender';
import { linkHostNote, misleadingLinkHost } from '@/lib/markdown/linkHost';
import { parseMarkdown } from '@/lib/markdown/parse';
import { renderHtml } from '@/lib/markdown/renderHtml';
import { renderText } from '@/lib/markdown/renderText';
import type { MarkdownContext } from '@/lib/markdown/types';
import { fastestRunMs } from './timing';

/** Characters that take no room on screen, written out because a literal one would be invisible in this file. */
const ZWSP = String.fromCodePoint(0x200b);
const SOFT_HYPHEN = String.fromCodePoint(0xad);
/** Looks like Latin `a`, is not. */
const CYRILLIC_A = String.fromCodePoint(0x430);
/** Looks like `:`, is not. */
const RATIO = String.fromCodePoint(0x2236);

const ctx: MarkdownContext = { names: { user: () => undefined, channel: () => undefined, role: () => undefined }, locale: 'en', timeZone: 'UTC' };

describe('misleadingLinkHost: nothing to say', () => {
  it.each([
    ['a label without an address', 'Click to verify your account', 'https://evil.example/x'],
    ['a plain word', 'docs', 'https://example.com/docs'],
    ['an empty label', '', 'https://example.com'],
    ['the same host', 'https://example.com/a', 'https://example.com/b'],
    ['the same host without a scheme', 'example.com', 'https://example.com/'],
    ['the same host apart from www', 'www.example.com/docs', 'https://example.com/docs'],
    ['the same host apart from case', 'EXAMPLE.com', 'https://example.COM/x'],
    ['the same host with another port', 'example.com', 'https://example.com:8443/x'],
    ['a trailing dot on the host', 'example.com.', 'https://example.com/x'],
    ['a sentence ending with the same domain', 'See the docs at example.com.', 'https://example.com/docs'],
    ['a version number', 'v1.2.3', 'https://github.com/x/y/releases/tag/v1.2.3'],
    ['a decimal', 'Release 2.5 notes', 'https://example.com/notes'],
    ['an abbreviation', 'e.g. this one', 'https://example.com/x'],
    ['a source file name', 'Next.js', 'https://nextjs.org'],
    ['a document file name', 'README.md', 'https://github.com/x/y/blob/main/README.md'],
    ['an ellipsis', 'Wait... what?', 'https://example.com/x'],
    ['dots between nothing', 'a..b and ..hidden', 'https://example.com/x'],
    ['a name with a one-letter top level', 'foo.bar.c', 'https://example.com/x'],
    ['a name too long to be a domain', `${'a'.repeat(300)}.com`, 'https://example.com/x'],
    ['a mailto target', 'https://discord.com', 'mailto:someone@example.com'],
    ['a target that is not a URL', 'https://discord.com', 'not a url'],
  ])('%s', (_name, label, href) => {
    expect(misleadingLinkHost(label, href)).toBeNull();
  });
});

describe('misleadingLinkHost: the label names another site', () => {
  it.each([
    ['a full URL', 'https://discord.com/login', 'https://evil.example/phish', 'evil.example'],
    ['a bare domain', 'discord.com', 'https://evil.example/phish', 'evil.example'],
    ['a domain with a path', 'discord.com/login', 'https://evil.example/phish', 'evil.example'],
    ['a www domain', 'www.paypal.com', 'https://evil.example/', 'evil.example'],
    ['a domain inside a sentence', 'Verify at discord.com/verify now', 'https://evil.example/', 'evil.example'],
    ['a domain in parentheses', 'Official (discord.com)', 'https://evil.example/', 'evil.example'],
    ['an http URL for an https target', 'http://discord.com', 'https://evil.example/', 'evil.example'],
    ['a parent domain', 'example.com', 'https://evil.example.com/', 'evil.example.com'],
    ['a sub-domain of the target', 'login.example.com', 'https://example.com/', 'example.com'],
    ['the target port', 'discord.com', 'https://evil.example:8443/x', 'evil.example:8443'],
    ['an email address', 'support@discord.com', 'https://evil.example/', 'evil.example'],
    ['a domain that is also a file type (zip)', 'invoice.zip', 'https://evil.example/', 'evil.example'],
  ])('%s', (_name, label, href, host) => {
    expect(misleadingLinkHost(label, href)).toBe(host);
  });

  it('is not fooled by userinfo in the target: the host is what comes after the @', () => {
    expect(misleadingLinkHost('https://good.com', 'https://good.com@evil.example/login')).toBe('evil.example');
    expect(misleadingLinkHost('good.com', 'https://good.com:secret@evil.example/')).toBe('evil.example');
  });

  it('flags userinfo in the label: the trusted name in front of the @ is not where the link goes', () => {
    expect(misleadingLinkHost('https://good.com@evil.example', 'https://evil.example/x')).toBe('evil.example');
    expect(misleadingLinkHost('https://good.com:secret@evil.example/login', 'https://evil.example/x')).toBe('evil.example');
    expect(misleadingLinkHost('https://evil.example@good.com', 'https://evil.example/x')).toBe('evil.example');
  });

  it('reads only the host of an address, not the names in its path', () => {
    expect(misleadingLinkHost('example.com/archive.tar.gz', 'https://example.com/files')).toBeNull();
    expect(misleadingLinkHost('https://example.com/a?next=other.org', 'https://example.com/')).toBeNull();
    expect(misleadingLinkHost('https://example.com/#evil.example', 'https://example.com/')).toBeNull();
  });

  it('shows the punycode form of an internationalised target, which exposes a look-alike domain', () => {
    const homograph = `https://${CYRILLIC_A}pple.com/id`;
    expect(misleadingLinkHost('apple.com', homograph)).toBe('xn--pple-43d.com');
    expect(misleadingLinkHost('https://apple.com/id', homograph)).toBe('xn--pple-43d.com');
  });

  it('treats an internationalised label and its punycode target as the same host', () => {
    expect(misleadingLinkHost('bücher.de', 'https://xn--bcher-kva.de/')).toBeNull();
    expect(misleadingLinkHost('https://bücher.de/katalog', 'https://BÜCHER.de/x')).toBeNull();
    expect(misleadingLinkHost('bücher.de', 'https://evil.example/')).toBe('evil.example');
  });

  it('sees through full-width letters, ideographic full stops and invisible characters', () => {
    expect(misleadingLinkHost('ｄｉｓｃｏｒｄ．ｃｏｍ', 'https://evil.example/')).toBe('evil.example');
    expect(misleadingLinkHost('discord。com', 'https://evil.example/')).toBe('evil.example');
    expect(misleadingLinkHost(`disc${ZWSP}ord.com`, 'https://evil.example/')).toBe('evil.example');
    expect(misleadingLinkHost(`discord${SOFT_HYPHEN}.com`, 'https://evil.example/')).toBe('evil.example');
    expect(misleadingLinkHost(`disc${ZWSP}ord.com`, 'https://discord.com/')).toBeNull();
  });

  it('is not fooled by a look-alike colon in the scheme', () => {
    expect(misleadingLinkHost(`https${RATIO}//discord.com/login`, 'https://evil.example/')).toBe('evil.example');
  });

  it('checks every address of the label', () => {
    expect(misleadingLinkHost('example.com or discord.com', 'https://example.com/')).toBe('example.com');
    expect(misleadingLinkHost('example.com and example.com/docs', 'https://example.com/')).toBeNull();
  });

  it('stays cheap on a long label', () => {
    const label = 'word '.repeat(2000) + 'discord.com';
    expect(misleadingLinkHost(label, 'https://evil.example/')).toBe('evil.example');
    expect(fastestRunMs(500, () => void misleadingLinkHost(label, 'https://evil.example/'))).toBeLessThan(500);
  });
});

describe('linkHostNote', () => {
  it('is the visible note: an arrow and the host in parentheses', () => {
    expect(linkHostNote('evil.example')).toBe(' ↗ (evil.example)');
  });
});

describe('the renderers on a spoofed masked link', () => {
  const source = '[https://discord.com/login](https://evil.example/phish)';
  const note = ' ↗ (evil.example)';

  it('the HTML export appends the real host inside the link, in its own class', () => {
    const markup = renderHtml(parseMarkdown(source), ctx);
    expect(markup).toBe(
      '<a class="md-link" href="https://evil.example/phish" target="_blank" rel="noopener noreferrer nofollow" title="https://evil.example/phish">' +
        `https://discord.com/login<span class="md-link-host">${note}</span></a>`,
    );
  });

  it('the Markdown export appends the same note to the visible text of the link (a Markdown link shows no destination)', () => {
    expect(markdownText(source, ctx)).toBe(`[https://discord.com/login${linkHostNote('evil.example')}](https://evil.example/phish)`);
  });

  it('plain text already prints the real address', () => {
    expect(renderText(parseMarkdown(source), ctx)).toBe('https://discord.com/login (https://evil.example/phish)');
  });

  it('shows a non-default port of the target', () => {
    const markup = renderHtml([{ type: 'link', url: 'https://evil.example:8080/', children: [{ type: 'text', text: 'discord.com' }], masked: true }], ctx);
    expect(markup).toContain('<span class="md-link-host"> ↗ (evil.example:8080)</span>');
  });

  it('formatting around the address does not hide it', () => {
    const markup = renderHtml(parseMarkdown('[**discord.com**](https://evil.example/x)'), ctx);
    expect(markup).toContain('<strong>discord.com</strong><span class="md-link-host">');
  });

  it('leaves ordinary masked links, bare links and links to the same host exactly as they were', () => {
    expect(renderHtml(parseMarkdown('[docs](https://a.com/d)'), ctx)).not.toContain('md-link-host');
    expect(renderHtml(parseMarkdown('https://a.com/x'), ctx)).not.toContain('md-link-host');
    expect(renderHtml(parseMarkdown('[a.com/x](https://a.com/y)'), ctx)).not.toContain('md-link-host');
    expect(renderHtml(parseMarkdown('<https://a.com/x>'), ctx)).not.toContain('md-link-host');
    expect(markdownText('[docs](https://a.com/d)', ctx)).toBe('[docs](https://a.com/d)');
  });

  it('userinfo tricks: the text shows a trusted host, the link goes to the host behind the @', () => {
    const markup = renderHtml(parseMarkdown('[https://good.com](https://good.com@evil.example/login)'), ctx);
    expect(markup).toContain('<span class="md-link-host"> ↗ (evil.example)</span>');
    expect(markdownText('[https://good.com](https://good.com@evil.example/login)', ctx)).toContain(linkHostNote('evil.example'));
  });

  it('look-alike (IDN) targets are shown in punycode', () => {
    const markup = renderHtml(parseMarkdown(`[apple.com](https://${CYRILLIC_A}pple.com/id)`), ctx);
    expect(markup).toContain('xn--pple-43d.com');
  });
});
