// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dmAvatarUrl,
  findRowById,
  nameFromLabel,
  nativeIconIn,
  rowContainer,
  rowName,
  rowsAffectedBy,
  rowsWithin,
  safeAvatarUrl,
  type Row,
} from '@/content/dom/rows';
import { hasStem, stemSelector } from '@/content/dom/selectors';
import {
  CHANNEL_ICON_CLASS,
  CHANNEL_SVG_CLASS,
  DM_CLOSE_CLASS,
  DM_CLOSE_SVG_CLASS,
  FAVORITE_ICON,
  GUILD,
  ID,
  WAVE_ICON,
  categoryRow,
  channelRow,
  dmRow,
  mount,
  nonRows,
  rowOf,
  sidebar,
  threadRow,
} from '../helpers/fixtures';

const rows = (): Row[] => rowsWithin(document.body);
const only = (): Row => {
  const found = rows();
  expect(found).toHaveLength(1);
  return found[0]!;
};

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('class stems', () => {
  it('match a token that starts with <stem>_ (hash after one or two underscores), nothing else', () => {
    const el = document.createElement('div');
    for (const [classes, expected] of [
      ['iconItem_c69b6d iconBase_c69b6d', true],
      ['children__2ea32', true],
      ['x children_abc', true],
      ['xchildren_abc', false],
      ['childrenWrapper_abc', false],
      ['Children_abc', false],
      ['children', false],
      ['', false],
    ] as const) {
      el.setAttribute('class', classes);
      expect(hasStem(el, 'children') || hasStem(el, 'iconItem'), classes).toBe(expected);
    }
  });

  it('the CSS selector agrees with hasStem', () => {
    mount(
      '<div class="children__2ea32" id="a"></div><div class="x children_9 y" id="b"></div><div class="xchildren_9" id="c"></div><div class="childrenX_9" id="d"></div>',
    );
    const ids = Array.from(document.querySelectorAll(stemSelector('children'))).map((el) => el.id);
    expect(ids).toEqual(['a', 'b']);
  });
});

describe('channel rows', () => {
  it('a text channel: id and guild from the href, name from data-dnd-name, container and native icon', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general' })));
    const row = only();
    expect(row).toMatchObject({ kind: 'channel', id: ID.general, guildId: GUILD });
    expect(rowName(row)).toBe('general');
    const container = rowContainer(row)!;
    expect(container.className).toBe('children__2ea32');
    expect(row.link.contains(container)).toBe(true);
    const native = nativeIconIn(row, container)!;
    expect(native.buttonClass).toBe(CHANNEL_ICON_CLASS);
    expect(native.svgClass).toBe(CHANNEL_SVG_CLASS);
    expect(native.svgSize).toBe(16);
    expect(native.inner).toBeNull();
    expect(native.button.getAttribute('role')).toBe('button');
  });

  it('a selected row is found the same way', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general', selected: true })));
    const row = only();
    expect(row.kind).toBe('channel');
    expect(row.root.className).toContain('selected_c69b6d');
    expect(rowContainer(row)).not.toBeNull();
  });

  it('the name is the data-dnd-name value as is (no prefix handling), spaces and symbols included', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'study room #2' })));
    expect(rowName(only())).toBe('study room #2');
  });

  it('a row without native icons still has its (empty) container', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general', icons: '' })));
    const row = only();
    const container = rowContainer(row)!;
    expect(container).not.toBeNull();
    expect(nativeIconIn(row, container)).toBeNull();
  });

  it('a row without any container gives null (Discord changed that part of the markup)', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general', container: false })));
    expect(rowContainer(only())).toBeNull();
  });

  it('a voice row has no href: the id comes from data-list-item-id and the guild is unknown to the row', () => {
    mount(sidebar(channelRow({ id: ID.voice, name: 'lounge', voice: true })));
    const row = only();
    expect(row).toMatchObject({ kind: 'voice', id: ID.voice, guildId: null });
    expect(rowName(row)).toBe('lounge');
    expect(rowContainer(row)).not.toBeNull();
  });

  it('an href the adapter does not know still gives a channel (id from the item id)', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general' }).replace(`/channels/${GUILD}/${ID.general}`, '/somewhere/else')));
    expect(only()).toMatchObject({ kind: 'channel', id: ID.general, guildId: null });
  });
});

describe('thread rows', () => {
  const withThread = (threadOptions: Parameters<typeof threadRow>[0] = { id: ID.thread, name: 'Thread A' }): string =>
    sidebar(channelRow({ id: ID.general, name: 'general', threads: [threadRow(threadOptions)] }));

  it('are found inside the parent channel`s li, classified as threads, and own their container', () => {
    mount(withThread());
    const found = rows();
    expect(found.map((r) => [r.kind, r.id])).toEqual([
      ['channel', ID.general],
      ['thread', ID.thread],
    ]);
    const [channel, thread] = found as [Row, Row];
    const channelContainer = rowContainer(channel)!;
    const threadContainer = rowContainer(thread)!;
    expect(channelContainer).not.toBe(threadContainer);
    expect(thread.link.contains(threadContainer)).toBe(true);
    expect(channel.root.contains(thread.root)).toBe(true);
    expect(rowName(thread)).toBe('Thread A');
    expect(nativeIconIn(thread, threadContainer)).toBeNull();
  });

  it('the channel`s container search never enters the nested thread list', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general', container: false, threads: [threadRow({ id: ID.thread, name: 'Thread A' })] })));
    const [channel, thread] = rows() as [Row, Row];
    expect(rowContainer(channel)).toBeNull(); // not the thread's container
    expect(rowContainer(thread)).not.toBeNull();
  });

  it('take their name from the name element when the li has no data-dnd-name', () => {
    mount(withThread({ id: ID.thread, name: 'Thread B', dndName: false }));
    const thread = rows()[1]!;
    expect(rowName(thread)).toBe('Thread B');
  });

  it('without the typeThread_ class, sitting in a nested ul[role=group] inside another row`s li is enough', () => {
    mount(withThread().replace(' typeThread_5d1e7', ''));
    expect(rows().map((r) => r.kind)).toEqual(['channel', 'thread']);
  });

  it('a thread list one wrapper deeper is found too', () => {
    mount(withThread().replace('<ul role="group">', '<ul role="group"><div>').replace('</ul></li>', '</div></ul></li>').replace(' typeThread_5d1e7', ''));
    expect(rows().map((r) => r.kind)).toEqual(['channel', 'thread']);
  });

  it('a no-href row in a list that is not nested in a row is a voice row, even if the list carries role=group', () => {
    mount(`<ul role="group">${channelRow({ id: ID.voice, name: 'lounge', voice: true })}</ul>`);
    expect(only().kind).toBe('voice');
  });

  it('a thread without a container is reported as such', () => {
    mount(withThread({ id: ID.thread, name: 'Thread A', container: false }));
    expect(rowContainer(rows()[1]!)).toBeNull();
  });
});

describe('category rows', () => {
  it('are told apart by aria-expanded; nothing is mirrored', () => {
    mount(sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })));
    const row = only();
    expect(row).toMatchObject({ kind: 'category', id: ID.categoryA, guildId: null });
    expect(rowName(row)).toBe('Category A');
    expect(nativeIconIn(row, rowContainer(row)!)).toBeNull();
  });

  it('the button goes into the iconVisibility_ / wrapper_ line (title + children_), not into children_, which shows on hover only', () => {
    mount(sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })));
    const row = only();
    const container = rowContainer(row)!;
    expect(container.className).toContain('iconVisibility__29444');
    expect(container.className).toContain('wrapper__29444');
    expect(container.parentElement).toBe(row.root);
    expect(container.contains(row.link)).toBe(true);
    const children = container.querySelector('[class^="children_"]')!;
    expect(children.parentElement).toBe(container); // a child of the line: ours goes after it, outside it
    expect(children.contains(container)).toBe(false);
  });

  it('without the line`s classes, the parent of children_ stands in; without both there is no container', () => {
    mount(sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' }).replace(/iconVisibility__29444 wrapper__29444 wrapperCommon__29444 /, '')));
    const row = only();
    const container = rowContainer(row)!;
    expect(container.className).toBe('clickable__29444');
    expect(container.querySelector('[class^="children_"]')).not.toBeNull();
    document.body.innerHTML = '';
    mount(sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' }).replace(/iconVisibility__29444 wrapper__29444 wrapperCommon__29444 /, '').replace('children__29444', 'kids__29444')));
    expect(rowContainer(only())).toBeNull();
  });

  it('a channel row is not mistaken for the category shape: its container stays children_ inside the link', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general' })));
    const container = rowContainer(only())!;
    expect(container.className).toBe('children__2ea32');
  });

  it('a no-href row WITHOUT aria-expanded is a voice row, not a category', () => {
    mount(sidebar(channelRow({ id: ID.voice, name: 'lounge', voice: true })));
    expect(only().kind).toBe('voice');
  });

  it('aria-expanded outside the link, inside the row, still makes a category', () => {
    mount(sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' }).replace(' aria-expanded="true"', '').replace('<div class="children__29444">', '<div class="children__29444" aria-expanded="true">')));
    expect(only().kind).toBe('category');
  });
});

describe('DM rows', () => {
  it('id from the href (not from uid_<n>), name from the name element, container and close button', () => {
    mount(dmRow({ id: ID.dm, name: 'Alex', position: 11 }));
    const row = only();
    expect(row).toMatchObject({ kind: 'dm', id: ID.dm, guildId: null });
    expect(rowName(row)).toBe('Alex');
    const container = rowContainer(row)!;
    expect(container.className).toBe('iconsContainer__972a0');
    expect(row.link.contains(container)).toBe(false); // a sibling of the link
    const native = nativeIconIn(row, container)!;
    expect(native.buttonClass).toBe(DM_CLOSE_CLASS);
    expect(native.svgClass).toBe(DM_CLOSE_SVG_CLASS);
    expect(native.inner).toEqual({ className: null }); // closeButton > div > svg
    expect(native.button.parentElement).toBe(container);
  });

  it('with a favourite and a wave icon before the close button', () => {
    mount(dmRow({ id: ID.dm, name: 'Alex', before: FAVORITE_ICON + WAVE_ICON }));
    const row = only();
    const container = rowContainer(row)!;
    const native = nativeIconIn(row, container)!;
    expect(native.button.className).toBe(DM_CLOSE_CLASS); // not the favourite or wave button
    expect(container.children).toHaveLength(3);
  });

  it('a group DM: the name element holds all names, the close button is the "leave group" one', () => {
    mount(dmRow({ id: ID.groupDm, name: 'Sam, Kim, Lee', group: true }));
    const row = only();
    expect(rowName(row)).toBe('Sam, Kim, Lee');
    const native = nativeIconIn(row, rowContainer(row)!)!;
    expect(native.button.getAttribute('aria-label')).toBe('Leave group');
  });

  it('a DM without a close button has a container but no native icon', () => {
    mount(dmRow({ id: ID.newFriendDm, name: 'Robin', close: false }));
    const row = only();
    const container = rowContainer(row)!;
    expect(container).not.toBeNull();
    expect(nativeIconIn(row, container)).toBeNull();
  });

  it('falls back to the numeric tail of data-list-item-id when there is no href', () => {
    mount(dmRow({ id: ID.dm, name: 'Alex' }).replace(`href="/channels/@me/${ID.dm}" `, ''));
    expect(only()).toMatchObject({ kind: 'dm', id: ID.dm });
  });

  it('falls back to the aria-label (before the parenthesis / comma) when the name element is empty', () => {
    mount(dmRow({ id: ID.dm, name: '' }).replace('aria-label=" (Direct message), online"', 'aria-label="Alex (Direct message), online"'));
    expect(document.querySelector('[class^="overflowTooltip_"]')?.textContent).toBe('');
    expect(rowName(only())).toBe('Alex');
  });

  it('a row that gives no name at all is named by its id (a target needs some name)', () => {
    mount(dmRow({ id: ID.dm, name: '' }).replace('aria-label=" (Direct message), online"', 'aria-label=""'));
    expect(rowName(only())).toBe(ID.dm);
  });

  it('the avatar URL: Discord CDN https only, resized for the popup; anything else is dropped', () => {
    mount(dmRow({ id: ID.dm, name: 'Alex' }));
    expect(dmAvatarUrl(only())).toBe(`https://cdn.discordapp.com/avatars/${ID.userHash}/${ID.userHash}.webp?size=64`);
    mount(dmRow({ id: ID.dm, name: 'Alex', avatar: null }));
    expect(dmAvatarUrl(only())).toBeNull();
    mount(dmRow({ id: ID.dm, name: 'Alex', avatar: 'https://evil.example/avatars/1/2.png' }));
    expect(dmAvatarUrl(only())).toBeNull();
  });

  it('safeAvatarUrl accepts avatars, default avatars and group icons on the two CDN hosts only', () => {
    expect(safeAvatarUrl('https://cdn.discordapp.com/embed/avatars/3.png')).toBe('https://cdn.discordapp.com/embed/avatars/3.png');
    expect(safeAvatarUrl('https://media.discordapp.net/avatars/1/2.png?size=32')).toBe('https://media.discordapp.net/avatars/1/2.png?size=64');
    expect(safeAvatarUrl('https://cdn.discordapp.com/channel-icons/1/2.png')).toContain('/channel-icons/1/2.png');
    for (const bad of [
      'http://cdn.discordapp.com/avatars/1/2.png',
      'https://cdn.discordapp.com/attachments/1/2/x.png',
      'https://example.com/avatars/1/2.png',
      'data:image/png;base64,AAAA',
      'avatars/1/2.png',
      '',
      null,
      undefined,
    ]) {
      expect(safeAvatarUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('what is not a row', () => {
  it('ignores non-numeric ids (events, channels & roles, friends, chat messages)', () => {
    mount(sidebar(nonRows()));
    expect(rows()).toEqual([]);
  });

  it('rows next to non-rows are still found, in document order', () => {
    mount(sidebar(nonRows(), categoryRow({ id: ID.categoryA, name: 'Category A' }), channelRow({ id: ID.general, name: 'general' })));
    expect(rows().map((r) => r.id)).toEqual([ID.categoryA, ID.general]);
  });

  it('our own button is never mistaken for a native icon', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general', icons: '' })));
    const row = only();
    const container = rowContainer(row)!;
    const ours = document.createElement('div');
    ours.setAttribute('data-dce', 'row-btn');
    ours.className = CHANNEL_ICON_CLASS;
    container.appendChild(ours);
    expect(nativeIconIn(row, container)).toBeNull();
  });
});

describe('finding rows from a changed node', () => {
  it('a rebuilt icon container finds its row (channel: the container is inside the link)', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general' })));
    const container = rowContainer(only())!;
    expect(rowsAffectedBy(container).map((r) => r.id)).toEqual([ID.general]);
  });

  it('a rebuilt DM container (a sibling of the link) finds its row through the li', () => {
    mount(dmRow({ id: ID.dm, name: 'Alex' }));
    const container = rowContainer(only())!;
    expect(rowsAffectedBy(container).map((r) => r.id)).toEqual([ID.dm]);
  });

  it('a rebuilt category container finds the category', () => {
    mount(sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })));
    const container = rowContainer(only())!;
    expect(rowsAffectedBy(container).map((r) => r.id)).toEqual([ID.categoryA]);
  });

  it('a whole added list finds every row in it', () => {
    mount(sidebar(categoryRow({ id: ID.categoryA, name: 'A' }), channelRow({ id: ID.general, name: 'general' }), channelRow({ id: ID.random, name: 'random' })));
    expect(rowsAffectedBy(document.querySelector('ul')!).map((r) => r.id)).toEqual([ID.categoryA, ID.general, ID.random]);
  });

  it('an unrelated node (a chat message) finds nothing', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general' })) + nonRows());
    const message = document.getElementById('chat-messages-1')!;
    expect(rowsAffectedBy(message)).toEqual([]);
  });
});

describe('findRowById', () => {
  it('finds the row of the chat in the address bar by its id', () => {
    mount(sidebar(channelRow({ id: ID.general, name: 'general' }), channelRow({ id: ID.random, name: 'random' })) + dmRow({ id: ID.dm, name: 'Alex' }));
    expect(findRowById(document, ID.random)?.kind).toBe('channel');
    expect(findRowById(document, ID.dm)?.kind).toBe('dm');
    expect(findRowById(document, '999')).toBeNull();
    expect(findRowById(document, 'not-a-number')).toBeNull();
    expect(rowOf(ID.random).getAttribute('data-dnd-name')).toBe('random');
  });
});

describe('nameFromLabel', () => {
  it('cuts at the trailing parenthesis, keeps names that contain commas or parentheses', () => {
    expect(nameFromLabel('Alex (Direct message), online')).toBe('Alex');
    expect(nameFromLabel('Sam, Kim, Lee (Group message), idle')).toBe('Sam, Kim, Lee');
    expect(nameFromLabel('Alex (he/him) (Direct message), online')).toBe('Alex (he/him)');
    expect(nameFromLabel('general (text channel)')).toBe('general');
    expect(nameFromLabel('Alex, online')).toBe('Alex');
    expect(nameFromLabel('Alex')).toBe('Alex');
    expect(nameFromLabel('')).toBe('');
    expect(nameFromLabel(null)).toBe('');
  });
});
