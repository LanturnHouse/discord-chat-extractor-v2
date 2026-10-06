// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_PATH, DOWNLOAD_PATH, REMOVE_PATH, currentIcon } from '@/content/inject/icons';
import { LOCAL } from '@/shared/storageKeys';
import { ACCOUNT, boot, groupsValue, type Booted } from '../helpers/app';
import {
  GUILD,
  GUILD_TWO,
  ID,
  INVITE_CLASS,
  allButtons,
  channelRow,
  dmRow,
  guildButtons,
  guildHeader,
  guildSidebar,
  guildWraps,
  mount,
  setPage,
} from '../helpers/fixtures';

let ctx: Booted | null = null;

const SERVER_TITLE = 'Discord | #general | Server One';

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('lang');
  setPage(`/channels/${GUILD}/${ID.general}`, SERVER_TITLE);
});

afterEach(() => {
  ctx?.app.destroy();
  ctx = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** A server's sidebar: the server header + two channel rows. */
const page = (header: string = guildHeader()): string =>
  guildSidebar(header, channelRow({ id: ID.general, name: 'general' }), channelRow({ id: ID.random, name: 'random' }));

const content = (): HTMLElement => document.querySelector<HTMLElement>('[class^="headerContent_"]')!;
const ownNodes = (): Element[] => Array.from(document.querySelectorAll('[data-dce]'));
const kids = (): HTMLElement[] => Array.from(content().children) as HTMLElement[];
/** A short name for each child of headerContent: its id, else our marker, else '' (Discord`s own, unnamed). */
const names = (): string[] => kids().map((el) => el.id || el.getAttribute('data-dce') || '');
/** Discord`s own invite button (ours carries the same class name, so the marker has to be excluded). */
const nativeInvite = (): HTMLElement => document.querySelector<HTMLElement>(`.${INVITE_CLASS}:not([data-dce])`)!;

/** The body as Discord rendered it: our nodes removed. */
function withoutOwnNodes(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const node of Array.from(clone.querySelectorAll('[data-dce]'))) node.remove();
  return clone.innerHTML;
}

/** What Discord does on a server switch: a new address, a new title and a new header + channel list. */
function switchServer(guild: string, name: string, header = guildHeader({ name })): void {
  setPage(`/channels/${guild}/${ID.random}`, `Discord | #random | ${name}`);
  document.body.innerHTML = guildSidebar(header, channelRow({ id: ID.random, name: 'random', guildId: guild }));
}

describe('placement', () => {
  it('is a span > div right before the invite button`s wrapper span (left of the person+ icon)', async () => {
    ctx = await boot({ html: page() });
    expect(kids().map((el) => el.tagName)).toEqual(['DIV', 'SPAN', 'SPAN']);
    const [menu, ours, invite] = kids();
    expect(menu!.className).toBe('guildDropdown_f37cb1'); // the server menu keeps its place
    expect(ours!.getAttribute('data-dce')).toBe('guild-wrap');
    expect(ours!.hasAttribute('class')).toBe(false); // a plain span, like Discord`s own tooltip wrapper
    expect(ours!.children).toHaveLength(1);
    expect(ours!.firstElementChild!.tagName).toBe('DIV');
    expect(ours!.firstElementChild!.getAttribute('data-dce')).toBe('guild-btn');
    expect(invite!.firstElementChild!.className).toBe(INVITE_CLASS); // the native button
    expect(invite!.hasAttribute('data-dce')).toBe(false);
    expect(guildButtons()).toHaveLength(1);
    expect(guildWraps()).toHaveLength(1);
  });

  it('an invite button that is not wrapped in a span: still right before it', async () => {
    ctx = await boot({ html: page(guildHeader({ wrapper: false })) });
    expect(kids().map((el) => el.tagName)).toEqual(['DIV', 'SPAN', 'DIV']);
    expect(kids()[2]!.className).toBe(INVITE_CLASS);
  });

  it('never touches Discord`s own nodes: with ours removed the page is exactly as rendered', async () => {
    mount(page());
    const baseline = document.body.innerHTML;
    const menu = document.querySelector('[class^="guildDropdown_"]')!;
    const inviteSpan = nativeInvite().parentElement!;
    ctx = await boot({});
    expect(guildButtons()).toHaveLength(1);
    expect(withoutOwnNodes()).toBe(baseline);
    expect(menu.parentElement).toBe(content()); // not moved, not wrapped
    expect(inviteSpan.parentElement).toBe(content());
  });

  it('a button added to a page that already has a header and rows: the rows are untouched by it and the other way round', async () => {
    ctx = await boot({ html: page() });
    expect(allButtons().map((b) => b.getAttribute('data-dce-key'))).toEqual([ID.general, ID.random]);
    expect(guildButtons()).toHaveLength(1);
    expect(ctx.app.injector.hasButtons()).toBe(true); // health is about the rows
  });

  it('a server button alone does not count as "buttons on the page" for the health check', async () => {
    ctx = await boot({ html: guildSidebar(guildHeader()) });
    expect(guildButtons()).toHaveLength(1);
    expect(ctx.app.injector.hasButtons()).toBe(false);
    expect(ctx.chrome.sent.filter((m) => m.type !== 'queue/groupInfo')).toEqual([]); // and it reports nothing by itself
  });
});

describe('margin-left:auto: next to the invite button, not in the middle of the space-between header', () => {
  // The header content is `display:flex; justify-content:space-between; gap:4px` (measured live): with three children the
  // middle one floats. An auto margin on our wrapper takes the free space first, so the wrapper sits right before the invite
  // button (Discord`s 4px gap), or at the right edge when there is no invite button.
  it('the wrapper span has margin-left:auto, between the server menu and the invite button', async () => {
    ctx = await boot({ html: page() });
    const wrap = guildWraps()[0]!;
    expect(wrap.style.marginLeft).toBe('auto');
    expect(wrap.previousElementSibling?.className).toBe('guildDropdown_f37cb1');
    expect(wrap.nextElementSibling?.firstElementChild?.className).toBe(INVITE_CLASS);
  });

  it('the same without an invite button: last in headerContent, still margin-left:auto (it goes to the right edge)', async () => {
    ctx = await boot({ html: page(guildHeader({ invite: false })) });
    const wrap = guildWraps()[0]!;
    expect(wrap.style.marginLeft).toBe('auto');
    expect(kids().at(-1)).toBe(wrap);
  });

  it('it stays on the wrapper when the look switches (invite button added or gone) and across passes', async () => {
    ctx = await boot({ html: page() });
    const wrap = guildWraps()[0]!;
    nativeInvite().parentElement!.remove();
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    expect(guildWraps()[0]).toBe(wrap);
    expect(wrap.style.marginLeft).toBe('auto');
  });

  it('a wrapper that is created again (the header was rebuilt) gets it too', async () => {
    ctx = await boot({ html: page() });
    switchServer(GUILD_TWO, 'Server Two');
    await ctx.frame();
    expect(guildWraps()).toHaveLength(1);
    expect(guildWraps()[0]!.style.marginLeft).toBe('auto');
  });

  it('the button itself (the div inside) carries no margin of its own: the gap to the invite button is Discord`s', async () => {
    ctx = await boot({ html: page() });
    expect(guildButtons()[0]!.style.marginLeft).toBe('');
    expect(guildButtons()[0]!.hasAttribute('style')).toBe(false);
  });

  it('the injected stylesheet has the same rule, for a page that drops the inline style', async () => {
    ctx = await boot({ html: page() });
    expect(document.getElementById('dce-style')!.textContent).toMatch(/\[data-dce="guild-wrap"\]\s*\{[^}]*margin-left:\s*auto/);
  });
});

describe('the check state (PLAN §2 "서버 버튼": checked iff every readable channel of the server is in the list)', () => {
  const iconOf = (): string | null => guildButtons()[0]!.querySelector('path')!.getAttribute('d');

  it('unchecked: the arrow, "state idle" and the "add" label; no group known for the server counts as unchecked', async () => {
    ctx = await boot({ html: page(), queue: [ID.general, ID.random] });
    expect(iconOf()).toBe(DOWNLOAD_PATH);
    expect(guildButtons()[0]!.getAttribute('data-dce-state')).toBe('idle');
    expect(guildButtons()[0]!.getAttribute('aria-label')).toBe('이 서버 채널 전부 추가');
  });

  it('checked: the check mark and the "remove" label, when the stored group of the server is completely in the list', async () => {
    ctx = await boot({ html: page(), queue: [ID.general, ID.random], groups: { [GUILD]: [ID.general, ID.random] } });
    expect(iconOf()).toBe(CHECK_PATH);
    expect(guildButtons()[0]!.getAttribute('data-dce-state')).toBe('queued');
    expect(guildButtons()[0]!.getAttribute('aria-label')).toBe('이 서버 채널 전부 빼기');
  });

  it('partial: one channel of the group is not in the list -> not checked', async () => {
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [GUILD]: [ID.general, ID.random] } });
    expect(iconOf()).toBe(DOWNLOAD_PATH);
  });

  it('English labels follow the state', async () => {
    document.documentElement.lang = 'en';
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [GUILD]: [ID.general] } });
    expect(guildButtons()[0]!.getAttribute('aria-label')).toBe('Remove every channel in this server');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [] });
    await ctx.settle();
    expect(guildButtons()[0]!.getAttribute('aria-label')).toBe('Add every channel in this server');
  });

  it('follows the storage of the queue and of the groups while the page is open', async () => {
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [GUILD]: [ID.general, ID.random] } });
    expect(iconOf()).toBe(DOWNLOAD_PATH);
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }, { key: ID.random }] });
    await ctx.settle();
    expect(iconOf()).toBe(CHECK_PATH);
    ctx.chrome.set({ [LOCAL.groups(ACCOUNT.id)]: groupsValue({ [GUILD]: [ID.general, ID.random, ID.forum] }) });
    await ctx.settle();
    expect(iconOf()).toBe(DOWNLOAD_PATH); // a new channel appeared in the server
  });

  it('a server switch: the button shows the state of the server now shown', async () => {
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [GUILD]: [ID.general] } });
    expect(iconOf()).toBe(CHECK_PATH);
    switchServer(GUILD_TWO, 'Server Two');
    await ctx.frame();
    expect(iconOf()).toBe(DOWNLOAD_PATH); // no group known for the second server
    switchServer(GUILD, 'Server One');
    await ctx.frame();
    expect(iconOf()).toBe(CHECK_PATH);
  });

  it('a category id in the groups does not make the server button checked (the group id is the guild id)', async () => {
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [ID.categoryA]: [ID.general] } });
    expect(iconOf()).toBe(DOWNLOAD_PATH);
  });
});

describe('look and attributes', () => {
  it('the div mirrors the native invite button`s className exactly (size, colour and hover are Discord`s own)', async () => {
    const inviteClass = 'inviteButton_f37cb1 button_a1b2c clickable_d3e4f';
    ctx = await boot({ html: page(guildHeader({ inviteClass })) });
    const button = guildButtons()[0]!;
    expect(button.className).toBe(inviteClass);
    expect(button.getAttribute('data-dce-src')).toBe('native');
  });

  it('follows the native class when Discord changes it (next pass)', async () => {
    ctx = await boot({ html: page() });
    nativeInvite().setAttribute('class', 'inviteButton_f37cb1 hover_9z8y7');
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    expect(guildButtons()[0]!.className).toBe('inviteButton_f37cb1 hover_9z8y7');
  });

  it('the svg is ours: 20x20, currentColor, the download arrow, hidden from assistive technology', async () => {
    ctx = await boot({ html: page() });
    const svg = guildButtons()[0]!.querySelector('svg')!;
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('20');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path')).toHaveLength(2); // the state glyph and the cross shown on hover while checked
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(DOWNLOAD_PATH);
    expect(svg.hasAttribute('class')).toBe(false); // the live invite svg has none
  });

  it('holds the cross next to the state glyph: always there, only the state glyph follows the check state', async () => {
    ctx = await boot({ html: page(), queue: [ID.general, ID.random], groups: { [GUILD]: [ID.general, ID.random] } });
    const svg = guildButtons()[0]!.querySelector('svg')!;
    const glyph = (name: string): Element => svg.querySelector(`path[data-dce-glyph="${name}"]`)!;
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(svg.querySelector('path')).toBe(glyph('state'));
    expect(glyph('state').getAttribute('d')).toBe(CHECK_PATH); // checked: the check mark (the hover cross is CSS, not a state)
    expect(glyph('remove').getAttribute('d')).toBe(REMOVE_PATH);
    expect(guildButtons()[0]!.getAttribute('data-dce-state')).toBe('queued'); // the attribute the stylesheet keys the swap on
    expect(currentIcon(svg)).toBe('check');

    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [] });
    await ctx.settle();
    expect(guildButtons()[0]!.querySelector('svg')).toBe(svg); // the same svg, nothing rebuilt
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(glyph('state').getAttribute('d')).toBe(DOWNLOAD_PATH);
    expect(glyph('remove').getAttribute('d')).toBe(REMOVE_PATH); // unchanged
    expect(guildButtons()[0]!.getAttribute('data-dce-state')).toBe('idle');
    expect(currentIcon(svg)).toBe('download');
  });

  it('a button re-looked (native class changes, fallback look) keeps both glyphs and its 20px size', async () => {
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [GUILD]: [ID.general] } });
    nativeInvite().parentElement!.remove(); // no invite button any more: the fallback look
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    const svg = guildButtons()[0]!.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe('dce-guild-icon');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('20');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(currentIcon(svg)).toBe('check');
  });

  it('the svg takes the class of the native invite svg when it has one', async () => {
    ctx = await boot({ html: page(guildHeader({ inviteSvgClass: 'icon_f37cb1' })) });
    expect(guildButtons()[0]!.querySelector('svg')!.getAttribute('class')).toBe('icon_f37cb1');
  });

  it('is a button for assistive technology and the keyboard, not draggable, with the key of the server', async () => {
    ctx = await boot({ html: page() });
    const button = guildButtons()[0]!;
    expect(button.getAttribute('role')).toBe('button');
    expect(button.getAttribute('tabindex')).toBe('0');
    expect(button.getAttribute('draggable')).toBe('false');
    expect(button.getAttribute('data-dce')).toBe('guild-btn');
    expect(button.getAttribute('data-dce-key')).toBe(GUILD);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('the label (also the tooltip text) is Korean by default', async () => {
    ctx = await boot({ html: page() });
    expect(guildButtons()[0]!.getAttribute('aria-label')).toBe('이 서버 채널 전부 추가');
  });

  it('English when the page is English; the language setting switches the label while the page is open', async () => {
    document.documentElement.lang = 'en-US';
    ctx = await boot({ html: page() });
    expect(guildButtons()[0]!.getAttribute('aria-label')).toBe('Add every channel in this server');
    ctx.chrome.set({ [LOCAL.settings]: { language: 'ko' } });
    await ctx.settle();
    expect(guildButtons()[0]!.getAttribute('aria-label')).toBe('이 서버 채널 전부 추가');
    ctx.chrome.set({ [LOCAL.settings]: { language: 'en' } });
    await ctx.settle();
    expect(guildButtons()[0]!.getAttribute('aria-label')).toBe('Add every channel in this server');
  });
});

describe('a header without an invite button (an account that cannot invite)', () => {
  it('the button is appended at the end of headerContent with our own look (32x32 CSS, 20px svg)', async () => {
    ctx = await boot({ html: page(guildHeader({ invite: false })) });
    expect(kids().map((el) => el.tagName)).toEqual(['DIV', 'SPAN']);
    expect(kids()[1]!.getAttribute('data-dce')).toBe('guild-wrap');
    const button = guildButtons()[0]!;
    expect(button.className).toBe('dce-guild-btn');
    expect(button.getAttribute('data-dce-src')).toBe('fallback');
    const svg = button.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe('dce-guild-icon');
    expect(svg.getAttribute('width')).toBe('20');
    expect(button.getAttribute('role')).toBe('button');
    expect(button.getAttribute('tabindex')).toBe('0');
    expect(button.getAttribute('draggable')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('이 서버 채널 전부 추가');
  });

  it('stays last when Discord adds something after it', async () => {
    ctx = await boot({ html: page(guildHeader({ invite: false })) });
    content().insertAdjacentHTML('beforeend', '<div id="boost" class="boostButton_f37cb1"></div>');
    await ctx.frame();
    expect(names()).toEqual(['', 'boost', 'guild-wrap']);
  });

  it('switches to the mirrored look and moves in front of the invite button when Discord adds one', async () => {
    ctx = await boot({ html: page(guildHeader({ invite: false })) });
    content().insertAdjacentHTML(
      'beforeend',
      `<span id="late"><div class="${INVITE_CLASS} extra_a1" role="button" tabindex="0"><svg width="20" height="20"></svg></div></span>`,
    );
    await ctx.frame();
    expect(names()).toEqual(['', 'guild-wrap', 'late']);
    const button = guildButtons()[0]!;
    expect(button.className).toBe(`${INVITE_CLASS} extra_a1`);
    expect(button.getAttribute('data-dce-src')).toBe('native');
    expect(button.querySelector('svg')!.hasAttribute('class')).toBe(false); // no leftover fallback svg class
    expect(guildButtons()).toHaveLength(1);
  });

  it('keeps working when the invite button goes away: the same one button, now with our own look, at the end', async () => {
    ctx = await boot({ html: page() });
    const button = guildButtons()[0]!;
    nativeInvite().parentElement!.remove();
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(guildButtons()[0]).toBe(button);
    expect(button.className).toBe('dce-guild-btn');
    expect(button.getAttribute('data-dce-src')).toBe('fallback');
    expect(kids().at(-1)).toBe(button.parentElement);
  });

  it('a new element between our button and the invite button: ours is moved to stay immediately before it', async () => {
    ctx = await boot({ html: page() });
    content().insertBefore(Object.assign(document.createElement('span'), { id: 'new-icon' }), kids()[2]!);
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(1); // Discord added a node: one pass
    ctx.scheduler.run();
    expect(names()).toEqual(['', 'new-icon', 'guild-wrap', '']);
    expect(kids()[3]!.firstElementChild!.className).toBe(INVITE_CLASS);
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(0); // and moving our own node back into place is not news
  });
});

describe('outside a server', () => {
  it('no button on the DM home (the address has no server, and there is no such header)', async () => {
    setPage('/channels/@me', 'Discord | Friends');
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex' }) });
    expect(guildButtons()).toEqual([]);
    expect(guildWraps()).toEqual([]);
    expect(allButtons()).toHaveLength(1); // the DM row button is there
  });

  it('no button in a DM chat either, even if a header-like element is on the page', async () => {
    setPage(`/channels/@me/${ID.dm}`, 'Discord | @Alex');
    ctx = await boot({ html: guildSidebar(guildHeader()) });
    expect(guildButtons()).toEqual([]);
    expect(ownNodes().filter((el) => el.getAttribute('data-dce') !== 'style')).toEqual([]);
  });

  it('no button on pages that are no server at all', async () => {
    setPage('/store', 'Discord | Shop');
    ctx = await boot({ html: guildSidebar(guildHeader()) });
    expect(guildButtons()).toEqual([]);
  });

  it('leaving a server for the DM home takes the button away, even when the header stays in the page for a moment', async () => {
    ctx = await boot({ html: page() });
    expect(guildButtons()).toHaveLength(1);
    setPage(`/channels/@me/${ID.dm}`, 'Discord | @Alex');
    ctx.app.injector.requestFullScan(); // what the navigation listeners ask for
    await ctx.frame();
    expect(guildButtons()).toEqual([]);
    expect(guildWraps()).toEqual([]);
    expect(document.querySelector('header')).not.toBeNull(); // Discord`s header untouched
  });

  it('DM home -> server: the button comes with the header', async () => {
    setPage('/channels/@me', 'Discord | Friends');
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex' }) });
    expect(guildButtons()).toEqual([]);
    switchServer(GUILD, 'Server One');
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(guildButtons()[0]!.getAttribute('data-dce-key')).toBe(GUILD);
  });

  it('server -> DM home (the whole sidebar is replaced): nothing of the server button is left', async () => {
    ctx = await boot({ html: page() });
    setPage(`/channels/@me/${ID.dm}`, 'Discord | @Alex');
    document.body.innerHTML = dmRow({ id: ID.dm, name: 'Alex' });
    await ctx.frame();
    expect(guildButtons()).toEqual([]);
    expect(guildWraps()).toEqual([]);
    expect(allButtons()).toHaveLength(1);
  });
});

describe('one button per header, whatever Discord re-renders', () => {
  it('the whole header is re-created: the new header gets its button, the old one`s is simply gone with it', async () => {
    ctx = await boot({ html: page() });
    const old = document.querySelector('header')!;
    const holder = document.createElement('div');
    holder.innerHTML = guildHeader();
    const fresh = holder.firstElementChild!;
    old.replaceWith(fresh);
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(fresh.querySelector('[data-dce="guild-btn"]')).not.toBeNull();
    expect(old.isConnected).toBe(false);
  });

  it('only headerContent is re-created', async () => {
    ctx = await boot({ html: page() });
    const old = content();
    const fresh = old.cloneNode(true) as HTMLElement;
    for (const node of Array.from(fresh.querySelectorAll('[data-dce]'))) node.remove();
    old.replaceWith(fresh);
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(fresh.querySelector('[data-dce="guild-btn"]')).not.toBeNull();
    expect(kids().map((el) => el.tagName)).toEqual(['DIV', 'SPAN', 'SPAN']);
  });

  it('Discord throws our node away (the children of headerContent are replaced): it comes back, once', async () => {
    ctx = await boot({ html: page() });
    const native = kids().filter((el) => !el.hasAttribute('data-dce'));
    content().replaceChildren(...native);
    expect(guildButtons()).toHaveLength(0);
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(kids().map((el) => el.tagName)).toEqual(['DIV', 'SPAN', 'SPAN']);
    expect(kids()[1]!.getAttribute('data-dce')).toBe('guild-wrap');
  });

  it('only our node is removed (nothing else changes, e.g. a second script of ours cleaning up): the next pass puts it back', async () => {
    ctx = await boot({ html: page() });
    guildWraps()[0]!.remove();
    expect(guildButtons()).toHaveLength(0);
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(names()).toEqual(['', 'guild-wrap', '']);
  });

  it('the invite button is re-created (a new span): ours is moved in front of the new one', async () => {
    ctx = await boot({ html: page() });
    const oldSpan = nativeInvite().parentElement!;
    const newSpan = oldSpan.cloneNode(true) as HTMLElement;
    oldSpan.replaceWith(newSpan);
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(kids()[1]!.getAttribute('data-dce')).toBe('guild-wrap');
    expect(kids()[2]).toBe(newSpan);
  });

  it('repeated passes never add a second one', async () => {
    ctx = await boot({ html: page() });
    for (let i = 0; i < 3; i++) {
      ctx.app.injector.requestFullScan();
      await ctx.frame();
    }
    expect(guildButtons()).toHaveLength(1);
    expect(guildWraps()).toHaveLength(1);
  });

  it('a copy of our button in the header (or a wrapper somebody emptied) is cleaned up on the next pass', async () => {
    ctx = await boot({ html: page() });
    const original = guildWraps()[0]!;
    content().appendChild(original.cloneNode(true));
    const emptied = document.createElement('span');
    emptied.setAttribute('data-dce', 'guild-wrap');
    content().insertBefore(emptied, original);
    expect(guildWraps()).toHaveLength(3);
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    expect(guildWraps()).toEqual([original]);
    expect(guildButtons()).toHaveLength(1);
    expect(kids()[1]).toBe(original);
  });

  it('two server headers on the page get one button each', async () => {
    ctx = await boot({ html: guildSidebar(guildHeader()) + guildSidebar(guildHeader({ name: 'Server Two', invite: false })) });
    expect(guildButtons()).toHaveLength(2);
    expect(document.querySelectorAll('header')[0]!.querySelectorAll('[data-dce="guild-btn"]')).toHaveLength(1);
    expect(document.querySelectorAll('header')[1]!.querySelectorAll('[data-dce="guild-btn"]')).toHaveLength(1);
  });

  it('other headers of the page get nothing', async () => {
    ctx = await boot({
      html:
        guildSidebar(guildHeader()) +
        '<header class="header_x1"><div class="headerContent_x1"><h2 class="name_x1">Panel</h2></div></header>',
    });
    expect(guildButtons()).toHaveLength(1);
    expect(document.querySelectorAll('header')[1]!.querySelector('[data-dce]')).toBeNull();
  });
});

describe('switching servers', () => {
  it('a header that survives the switch keeps its one button, which then belongs to the new server', async () => {
    ctx = await boot({ html: page(guildHeader({ name: 'Server One' })) });
    const button = guildButtons()[0]!;
    expect(button.getAttribute('data-dce-key')).toBe(GUILD);

    setPage(`/channels/${GUILD_TWO}/${ID.random}`, 'Discord | #random | Server Two');
    document.querySelector('h2')!.textContent = 'Server Two';
    document.querySelector('ul')!.innerHTML = channelRow({ id: '200000000000000071', name: 'other', guildId: GUILD_TWO });
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(guildButtons()[0]).toBe(button);
    expect(button.getAttribute('data-dce-key')).toBe(GUILD_TWO);
  });

  it('a new header per server: exactly one button after every switch, back and forth', async () => {
    ctx = await boot({ html: page() });
    for (const [guild, name] of [
      [GUILD_TWO, 'Server Two'],
      [GUILD, 'Server One'],
      [GUILD_TWO, 'Server Two'],
    ] as const) {
      switchServer(guild, name);
      await ctx.frame();
      expect(guildButtons(), name).toHaveLength(1);
      expect(guildButtons()[0]!.getAttribute('data-dce-key')).toBe(guild);
      expect(guildButtons()[0]!.closest('header')).toBe(document.querySelector('header'));
    }
  });

  it('the look follows the server: with invite rights it mirrors, without them it falls back (and back again)', async () => {
    ctx = await boot({ html: page() });
    expect(guildButtons()[0]!.getAttribute('data-dce-src')).toBe('native');
    switchServer(GUILD_TWO, 'Server Two', guildHeader({ name: 'Server Two', invite: false }));
    await ctx.frame();
    expect(guildButtons()[0]!.getAttribute('data-dce-src')).toBe('fallback');
    expect(kids().at(-1)!.getAttribute('data-dce')).toBe('guild-wrap');
    switchServer(GUILD, 'Server One');
    await ctx.frame();
    expect(guildButtons()[0]!.getAttribute('data-dce-src')).toBe('native');
    expect(kids()[1]!.getAttribute('data-dce')).toBe('guild-wrap');
  });
});

describe('quiet', () => {
  it('a repeated pass over the same header writes nothing to the DOM', async () => {
    ctx = await boot({ html: page(), queue: [ID.general] });
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    ctx.app.injector.refreshAll();
    records.push(...observer.takeRecords());
    observer.disconnect();
    expect(records).toEqual([]);
    expect(guildButtons()).toHaveLength(1);
  });

  it('the same for a header without an invite button', async () => {
    ctx = await boot({ html: page(guildHeader({ invite: false })) });
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    records.push(...observer.takeRecords());
    observer.disconnect();
    expect(records).toEqual([]);
  });

  it('putting the button in never causes another pass (no feedback loop)', async () => {
    ctx = await boot({ html: page() });
    expect(ctx.scheduler.pending).toBe(0);
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(0);
  });

  it('the text change of a server name (no node added) needs no pass: the button reads the name when it is clicked', async () => {
    ctx = await boot({ html: page() });
    document.querySelector('h2')!.textContent = 'Renamed';
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(0);
  });
});

describe('with the real animation-frame scheduler and the real MutationObserver', () => {
  async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it('the button appears on its own, survives a server switch, and goes with the buttons switch', async () => {
    ctx = await boot({ html: page(), realFrames: true });
    await until(() => guildButtons().length === 1);
    expect(guildButtons()).toHaveLength(1);

    switchServer(GUILD_TWO, 'Server Two');
    await until(() => guildButtons().length === 1 && guildButtons()[0]!.getAttribute('data-dce-key') === GUILD_TWO);
    expect(guildButtons()).toHaveLength(1);
    expect(guildButtons()[0]!.getAttribute('data-dce-key')).toBe(GUILD_TWO);

    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await until(() => ownNodes().length === 0);
    expect(ownNodes()).toEqual([]);
  });
});

describe('teardown', () => {
  it('buttons switched off in the settings: nothing of ours is stored in the page, not even the style', async () => {
    ctx = await boot({ html: page(), settings: { showButtons: false } });
    expect(ownNodes()).toEqual([]);
    expect(guildButtons()).toEqual([]);
  });

  it('switched off while running: the button and its wrapper go; switched on again: they come back', async () => {
    ctx = await boot({ html: page() });
    expect(guildButtons()).toHaveLength(1);
    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await ctx.settle();
    expect(ownNodes()).toEqual([]);
    expect(kids().map((el) => el.tagName)).toEqual(['DIV', 'SPAN']); // Discord`s two children, as rendered
    // observer disconnected: a re-created header gets nothing while the buttons are off
    switchServer(GUILD_TWO, 'Server Two');
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(0);
    ctx.scheduler.run();
    expect(guildButtons()).toEqual([]);

    ctx.chrome.set({ [LOCAL.settings]: { showButtons: true } });
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(guildButtons()[0]!.getAttribute('data-dce-key')).toBe(GUILD_TWO);
  });

  it('destroy() removes it, and nothing puts it back afterwards', async () => {
    ctx = await boot({ html: page() });
    ctx.app.destroy();
    expect(ownNodes()).toEqual([]);
    content().appendChild(document.createElement('span'));
    await ctx.frame();
    expect(ownNodes()).toEqual([]);
  });

  it('the extension was reloaded (context invalidated): the next pass removes it silently', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await boot({ html: page() });
    ctx.chrome.invalidate();
    content().appendChild(document.createElement('span'));
    await ctx.frame();
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('a leftover of an earlier run (a button no live script owns any more) is removed when the buttons start', async () => {
    mount(page() + '<span data-dce="guild-wrap"><div data-dce="guild-btn" role="button"></div></span>');
    const stale = document.querySelector('[data-dce="guild-wrap"]')!;
    ctx = await boot({});
    expect(stale.isConnected).toBe(false);
    expect(guildButtons()).toHaveLength(1);
    expect(guildButtons()[0]!.closest('header')).not.toBeNull();
  });
});
