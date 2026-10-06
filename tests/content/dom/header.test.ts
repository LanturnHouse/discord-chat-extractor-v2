// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findGuildHeaders, guildNameFor, guildNameIn } from '@/content/dom/header';
import { guildRequest } from '@/content/dom/target';
import { GUILD, GUILD_TWO, ID, INVITE_CLASS, guildHeader, guildSidebar, mount, setPage } from '../helpers/fixtures';

beforeEach(() => {
  document.body.innerHTML = '';
  setPage(`/channels/${GUILD}/${ID.general}`, '(8) Discord | #general | Server One');
});
afterEach(() => {
  document.body.innerHTML = '';
});

const only = () => {
  const found = findGuildHeaders(document);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('findGuildHeaders (PLAN §4 "서버 이름 헤더")', () => {
  it('finds the header, its content, the native invite button and the wrapper span our button goes in front of', () => {
    mount(guildSidebar(guildHeader()));
    const found = only();
    expect(found.header.tagName).toBe('HEADER');
    expect(found.content.className).toBe('headerContent_f37cb1 primaryInfo_f37cb1');
    expect(found.header.contains(found.content)).toBe(true);
    expect(found.invite?.className).toBe(INVITE_CLASS);
    expect(found.invite?.getAttribute('role')).toBe('button');
    expect(found.slot?.tagName).toBe('SPAN');
    expect(found.slot?.parentElement).toBe(found.content);
    expect(found.slot?.contains(found.invite)).toBe(true);
  });

  it('an account without the right to invite: the header is still found (the server menu is there), without invite and slot', () => {
    mount(guildSidebar(guildHeader({ invite: false })));
    const found = only();
    expect(found.invite).toBeNull();
    expect(found.slot).toBeNull();
    expect(found.content.className).toContain('headerContent_');
  });

  it('an invite button that is not wrapped is its own slot; one nested deeper hangs under the child of the content', () => {
    mount(guildSidebar(guildHeader({ wrapper: false })));
    let found = only();
    expect(found.slot).toBe(found.invite);

    document.body.innerHTML = '';
    mount(
      guildSidebar(
        guildHeader({ invite: false }).replace(
          '</div></header>',
          `<div id="group"><span><div class="${INVITE_CLASS}" role="button"></div></span></div></div></header>`,
        ),
      ),
    );
    found = only();
    expect(found.slot?.id).toBe('group');
  });

  it('a page without any header gives nothing', () => {
    mount('<div id="chat"></div>');
    expect(findGuildHeaders(document)).toEqual([]);
  });

  it('other headers of the page are not server headers (no server menu and no invite button in them)', () => {
    mount(
      '<header class="header_x1"><div class="headerContent_x1"><h2 class="name_x1">Some panel</h2></div></header>' +
        '<header class="header_x2"><h2 class="name_x2">No content element</h2></header>' +
        '<header><div class="headerContent_x3"></div></header>',
    );
    expect(findGuildHeaders(document)).toEqual([]);
  });

  it('the stems are matched like everywhere else: a token that merely contains or extends the name does not count', () => {
    mount(guildSidebar(guildHeader()));
    const header = document.querySelector('header')!;
    header.setAttribute('class', 'subheader_f37cb1');
    expect(findGuildHeaders(document)).toEqual([]);
    header.setAttribute('class', 'header_f37cb1');

    const content = header.querySelector('div')!;
    content.setAttribute('class', 'headerContentWrapper_f37cb1');
    expect(findGuildHeaders(document)).toEqual([]);
    content.setAttribute('class', 'headerContent_f37cb1');

    const invite = header.querySelector(`.${INVITE_CLASS}`)!;
    invite.setAttribute('class', 'inviteButtonIcon_f37cb1');
    expect(only().invite).toBeNull(); // the server menu still makes it a server header
    invite.setAttribute('class', 'inviteButton_f37cb1');
    expect(only().invite).toBe(invite);
  });

  it('the native invite button needs role=button', () => {
    mount(guildSidebar(guildHeader()));
    document.querySelector(`.${INVITE_CLASS}`)!.removeAttribute('role');
    expect(only().invite).toBeNull();
  });

  it('never takes one of OUR nodes for the native invite button, although ours carries the same class name', () => {
    mount(guildSidebar(guildHeader()));
    const native = document.querySelector<HTMLElement>(`.${INVITE_CLASS}`)!;
    const wrap = document.createElement('span');
    wrap.setAttribute('data-dce', 'guild-wrap');
    const ours = document.createElement('div');
    ours.setAttribute('data-dce', 'guild-btn');
    ours.setAttribute('role', 'button');
    ours.className = INVITE_CLASS;
    wrap.appendChild(ours);
    native.parentElement!.before(wrap); // in front of the native wrapper, i.e. FIRST in document order

    const found = only();
    expect(found.invite).toBe(native);
    expect(found.slot).toBe(native.parentElement);

    native.parentElement!.remove(); // no native one left: ours is not one
    expect(only().invite).toBeNull();
  });

  it('finds every server header of the page', () => {
    mount(guildSidebar(guildHeader()) + guildSidebar(guildHeader({ name: 'Server Two', invite: false })));
    expect(findGuildHeaders(document)).toHaveLength(2);
  });
});

describe('the server name', () => {
  it('is the text of h2.name_* in the header, whitespace collapsed', () => {
    mount(guildSidebar(guildHeader({ name: '  Server   One ' })));
    expect(guildNameIn(only().header)).toBe('Server One');
  });

  it('is null without a name element, with an empty one, or without a header', () => {
    mount(guildSidebar(guildHeader({ name: null })));
    expect(guildNameIn(only().header)).toBeNull();
    document.body.innerHTML = '';
    mount(guildSidebar(guildHeader({ name: '   ' })));
    expect(guildNameIn(only().header)).toBeNull();
    expect(guildNameIn(null)).toBeNull();
  });

  it('only an h2 with a name_ class counts (not a div.name_, not a bare h2)', () => {
    mount(guildSidebar(guildHeader({ name: null })));
    const holder = document.querySelector('.guildBadgeAndName_f37cb1')!;
    holder.innerHTML = '<div class="name_f37cb1">Not a heading</div><h2>Bare heading</h2><h2 class="title_f37cb1">Other</h2>';
    expect(guildNameIn(only().header)).toBeNull();
  });

  it('falls back to the last | segment of the tab title (only inside a guild)', () => {
    mount(guildSidebar(guildHeader({ name: null })));
    const header = only().header;
    expect(guildNameFor(header, document, `/channels/${GUILD}/${ID.general}`)).toBe('Server One');
    expect(guildNameFor(header, document, '/channels/@me')).toBeNull();
    setPage(`/channels/${GUILD}/${ID.general}`, 'Discord');
    expect(guildNameFor(header, document, `/channels/${GUILD}/${ID.general}`)).toBeNull();
  });

  it('the header wins over the title', () => {
    mount(guildSidebar(guildHeader({ name: 'Header Name' })));
    expect(guildNameFor(only().header, document, `/channels/${GUILD}/${ID.general}`)).toBe('Header Name');
  });

  it('is capped to a sane length', () => {
    mount(guildSidebar(guildHeader({ name: 'x'.repeat(2000) })));
    expect(guildNameIn(only().header)).toHaveLength(500);
  });
});

describe('guildRequest (queue/addGuild)', () => {
  it('guild id from the address bar, name from the header the button sits in', () => {
    mount(guildSidebar(guildHeader({ name: 'Server One' })));
    const inside = only().content;
    expect(guildRequest(inside)).toEqual({ guildId: GUILD, guildName: 'Server One' });
  });

  it('follows the address bar: a header that survives a server switch acts on the server being shown', () => {
    mount(guildSidebar(guildHeader({ name: 'Server One' })));
    const found = only();
    setPage(`/channels/${GUILD_TWO}/${ID.random}`, 'Discord | #random | Server Two');
    found.header.querySelector('h2')!.textContent = 'Server Two';
    expect(guildRequest(found.content)).toEqual({ guildId: GUILD_TWO, guildName: 'Server Two' });
  });

  it('a button outside any header (or a header without a name) uses the tab title', () => {
    mount(guildSidebar(guildHeader({ name: null })) + '<div id="lonely"></div>');
    expect(guildRequest(only().content)).toEqual({ guildId: GUILD, guildName: 'Server One' });
    expect(guildRequest(document.getElementById('lonely')!)).toEqual({ guildId: GUILD, guildName: 'Server One' });
  });

  it('the name is null when neither the header nor the title tells it', () => {
    setPage(`/channels/${GUILD}/${ID.general}`, 'Discord');
    mount(guildSidebar(guildHeader({ name: null })));
    expect(guildRequest(only().content)).toEqual({ guildId: GUILD, guildName: null });
  });

  it('there is no request outside a server: the DM home has no server header', () => {
    mount(guildSidebar(guildHeader()));
    const inside = only().content;
    for (const path of ['/channels/@me', `/channels/@me/${ID.dm}`, '/store', '/']) {
      setPage(path, 'Discord');
      expect(guildRequest(inside), path).toBeNull();
    }
  });

  it('the guild id also comes from a jump link or a server page without a channel', () => {
    mount(guildSidebar(guildHeader()));
    const inside = only().content;
    setPage(`/channels/${GUILD}/${ID.general}/900000000000000001`, 'Discord | #general | Server One');
    expect(guildRequest(inside)?.guildId).toBe(GUILD);
    setPage(`/channels/${GUILD}`, 'Discord | Server One');
    expect(guildRequest(inside)?.guildId).toBe(GUILD);
  });
});
